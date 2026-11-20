"""Read Euronext's public EBM settlement table; standard library only.

The official page's own JavaScript calls POST /en/ajax/getTabPrices/EBM-DPAR/futures.
This adapter consumes the separately labelled Settle column, never Last or Close.
It discovers every listed maturity and recent trade date from the page, validates
the date printed in each response, and omits dates whose settlements are not yet
published. It does not authenticate, bypass controls, schedule jobs or publish.

Access note: Euronext website terms restrict automated/systematic retrieval without
permission; public technical availability is not a data-use or redistribution
license. Euronext NextHistory EOD is the supported credentialed alternative.
"""
from __future__ import annotations

import datetime as dt
import calendar
import hashlib
import json
import math
import re
import time
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SOURCE_URL = "https://live.euronext.com/en/product/commodities-futures/EBM-DPAR/settlement-prices"
TABLE_URL = "https://live.euronext.com/en/ajax/getTabPrices/EBM-DPAR/futures"
TERMS_URL = "https://www.euronext.com/en/terms-use"
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
MONTH_CODES = "FGHJKMNQUVXZ"
MONTH_NUMBER = {name.lower(): n + 1 for n, name in enumerate(MONTHS)}
DATE_MONTH_NUMBER = {name.lower(): n for n in range(1, 13) for name in (calendar.month_name[n], calendar.month_abbr[n])}
MISSING = {"", "-", "—", "–", "n/a", "na", "null"}


class SourceError(RuntimeError):
    """The source could not be read or failed settlement identity checks."""


def _text(value: str) -> str:
    return " ".join(value.replace("\xa0", " ").split())


def _english_date(value: str) -> dt.date:
    match = re.fullmatch(r"(\d{1,2}) ([A-Za-z]+) (\d{4})", _text(value))
    if not match or match[2].lower() not in DATE_MONTH_NUMBER:
        raise SourceError(f"Unrecognised explicit source date: {value!r}")
    return dt.date(int(match[3]), DATE_MONTH_NUMBER[match[2].lower()], int(match[1]))


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.select = None
        self.option = None
        self.options = {"maturityFilter": [], "tradingFilter": []}
        self.maturity_type = None
        self.settings = None
        self.settings_chunks = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "select":
            self.select = attrs.get("id") if attrs.get("id") in self.options else None
        elif tag == "option" and self.select:
            self.option = {"value": attrs.get("value", ""), "label": []}
        elif tag == "input" and attrs.get("id") == "maturityTypeFilter":
            self.maturity_type = attrs.get("value")
        elif tag == "script" and attrs.get("data-drupal-selector") == "drupal-settings-json":
            self.settings_chunks = []

    def handle_data(self, data):
        if self.option is not None:
            self.option["label"].append(data)
        if self.settings_chunks is not None:
            self.settings_chunks.append(data)

    def handle_endtag(self, tag):
        if tag == "option" and self.option is not None:
            self.option["label"] = _text("".join(self.option["label"]))
            self.options[self.select].append(self.option)
            self.option = None
        elif tag == "select":
            self.select = None
        elif tag == "script" and self.settings_chunks is not None:
            self.settings = json.loads("".join(self.settings_chunks))
            self.settings_chunks = None


def parse_selection_page(body: str) -> dict:
    parser = _PageParser()
    parser.feed(body)
    settings = parser.settings or {}
    if settings.get("instrument") != "EBM-DPAR" or settings.get("param") != "futures":
        raise SourceError("Page does not identify EBM-DPAR futures; refusing another product.")
    if parser.maturity_type != "M":
        raise SourceError("Unexpected maturity type; monthly contract mapping is required.")
    maturities = []
    for option in parser.options["maturityFilter"]:
        value, label = option["value"], option["label"]
        match = re.fullmatch(r"([A-Za-z]{3}) (\d{4})", label)
        if not match or match[1].lower() not in MONTH_NUMBER:
            raise SourceError(f"Ambiguous contract delivery: {label!r}")
        date = dt.datetime.strptime(value, "%m-%d-%Y").date()
        month = MONTH_NUMBER[match[1].lower()]
        if date.day != 1 or (date.year, date.month) != (int(match[2]), month):
            raise SourceError("Maturity filter label and request value disagree.")
        maturities.append({"value": value, "month": MONTHS[month - 1], "delivery_year": date.year})
    dates = []
    for option in parser.options["tradingFilter"]:
        date = dt.datetime.strptime(option["value"], "%m-%d-%Y").date()
        if date != _english_date(option["label"]):
            raise SourceError("Trade-date label and request value disagree.")
        dates.append({"value": option["value"], "date": date.isoformat()})
    if not maturities or not any(m["month"] == "Mar" for m in maturities):
        raise SourceError("No identifiable March EBM contract in the source selection.")
    if len({m["value"] for m in maturities}) != len(maturities):
        raise SourceError("Duplicate maturity selections.")
    if not dates or len({d["date"] for d in dates}) != len(dates):
        raise SourceError("Empty or duplicate trade-date selections.")
    return {"maturities": maturities, "trade_dates": dates}


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables = 0
        self.table_depth = 0
        self.row = None
        self.cell = None
        self.cell_tag = None
        self.rows = []
        self.heading_depth = 0
        self.heading = []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables += 1
            self.table_depth += 1
        elif tag == "h3":
            self.heading_depth += 1
        elif self.table_depth and tag == "tr":
            self.row = []
        elif self.row is not None and tag in {"th", "td"}:
            self.cell = []
            self.cell_tag = tag

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)
        if self.heading_depth:
            self.heading.append(data)

    def handle_endtag(self, tag):
        if tag == "h3":
            self.heading_depth = max(0, self.heading_depth - 1)
        elif tag in {"th", "td"} and self.cell is not None:
            self.row.append((self.cell_tag, _text("".join(self.cell))))
            self.cell = None
            self.cell_tag = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None
        elif tag == "table":
            self.table_depth -= 1


def _number(value: str, *, integer: bool = False):
    value = _text(value)
    if value.lower() in MISSING:
        return None
    # Source is the English page: dot decimal, comma or spaces only thousands separators.
    normalized = value.replace(" ", "")
    if not re.fullmatch(r"[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", normalized):
        raise SourceError(f"Invalid numeric source cell: {value!r}")
    compact = normalized.replace(",", "")
    result = float(compact)
    if not math.isfinite(result):
        raise SourceError("Non-finite source number.")
    if integer:
        if result < 0 or not result.is_integer():
            raise SourceError(f"Invalid contract count: {value!r}")
        return int(result)
    return result


def parse_settlement_table(body: str, requested_date: str, maturities: list[dict]) -> tuple[list[dict], dict]:
    parser = _TableParser()
    parser.feed(body)
    parser.close()
    if parser.table_depth != 0 or parser.row is not None or parser.cell is not None or parser.heading_depth != 0:
        raise SourceError("Truncated or unclosed settlement table/heading.")
    heading = _text(" ".join(parser.heading))
    match = re.fullmatch(r"Prices - (\d{1,2} [A-Za-z]+ \d{4})", heading)
    intraday = False
    if match is None:
        match = re.fullmatch(r"Prices as of (\d{1,2} [A-Za-z]+ \d{4}) \d{1,2}:\d{2} (?:CET|CEST)", heading)
        intraday = True
    if match is None:
        raise SourceError(f"No unambiguous dated settlement heading: {heading!r}")
    actual_date = _english_date(match[1]).isoformat()
    if actual_date != requested_date:
        raise SourceError(f"Requested {requested_date}, but source explicitly identifies {actual_date}.")
    if parser.tables != 1:
        raise SourceError(f"Expected exactly one settlement table, received {parser.tables}.")
    headers = [row for row in parser.rows if row and all(tag == "th" for tag, text in row)]
    if len(headers) != 1:
        raise SourceError("Missing or ambiguous table header.")
    names = [text.lower() for tag, text in headers[0]]
    if len(names) != len(set(names)) or "delivery" not in names or "settle" not in names:
        raise SourceError("Explicit Delivery and Settle columns are required.")
    expected = {(m["month"], m["delivery_year"]) for m in maturities}
    seen = set()
    rows, missing_settlements = [], []
    for cells in parser.rows:
        if not cells or cells[0][0] == "th":
            continue
        if len(cells) != len(names):
            raise SourceError("Settlement row width differs from the labelled columns.")
        fields = dict(zip(names, [text for tag, text in cells]))
        if not fields["delivery"] and fields["settle"].lower() == "total":
            continue
        delivery = re.fullmatch(r"([A-Za-z]{3}) (\d{4})", fields["delivery"])
        if not delivery or delivery[1].lower() not in MONTH_NUMBER:
            raise SourceError(f"Ambiguous delivery row: {fields['delivery']!r}")
        month_num, year = MONTH_NUMBER[delivery[1].lower()], int(delivery[2])
        month = MONTHS[month_num - 1]
        identity = (month, year)
        if identity not in expected or identity in seen:
            raise SourceError("Unexpected or duplicate delivery in settlement table.")
        seen.add(identity)
        settlement = _number(fields["settle"])
        if settlement is None:
            missing_settlements.append(f"{month} {year}")
            continue
        if settlement <= 0:
            raise SourceError("Nonpositive EBM settlement; refusing a missing-data placeholder.")
        rows.append({"date": actual_date, "contract": f"ML{MONTH_CODES[month_num - 1]}{year % 100:02d}",
                     "month": month, "delivery_year": year, "matif_eur_t": settlement,
                     "volume": _number(fields.get("volume", ""), integer=True),
                     "open_interest": _number(fields.get("open interest", ""), integer=True)})
    if seen != expected:
        raise SourceError("Source omitted one or more requested contract deliveries.")
    if not rows:
        if intraday and missing_settlements and len(missing_settlements) == len(expected):
            return [], {"date": actual_date, "status": "unpublished", "heading": heading,
                        "reason": "All explicitly labelled Settle cells are N/A; Last is ignored."}
        raise SourceError("Empty historical settlement table; refusing an empty successful collection.")
    if missing_settlements:
        raise SourceError("Partially published settlement table; retry later instead of ingesting a partial curve.")
    if not any(row["month"] == "Mar" for row in rows):
        raise SourceError("Published settlement table contains no March contract.")
    return rows, {"date": actual_date, "status": "published", "heading": heading, "rows": len(rows)}


def _request(url: str, payload: dict | None, *, timeout: float, attempts: int) -> dict:
    data = urlencode(payload, doseq=True).encode("ascii") if payload is not None else None
    headers = {"User-Agent": "WheatSeasonals/1.0 (daily EBM settlement verification)", "Accept": "text/html"}
    if payload is not None:
        headers.update({"Referer": SOURCE_URL, "X-Requested-With": "XMLHttpRequest",
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"})
    request = Request(url, data=data, headers=headers)
    for attempt in range(attempts):
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read()
                if response.status != 200 or not raw:
                    raise SourceError("Empty or unsuccessful Euronext response.")
                if response.url.split("?", 1)[0] != url:
                    raise SourceError("Source redirected away from the expected public endpoint.")
                return {"url": url, "payload": payload, "body": raw.decode("utf-8"),
                        "sha256": hashlib.sha256(raw).hexdigest(), "method": "POST" if payload is not None else "GET",
                        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat()}
        except HTTPError as exc:
            if exc.code not in {429, 500, 502, 503, 504} or attempt + 1 == attempts:
                raise SourceError(f"Euronext HTTP {exc.code}; no authentication or control bypass attempted.") from exc
        except (URLError, TimeoutError) as exc:
            if attempt + 1 == attempts:
                raise SourceError(f"Euronext request failed after {attempts} attempts: {exc}") from exc
        time.sleep(min(2 ** attempt, 4))
    raise SourceError("Euronext retry limit reached.")


def collect(*, timeout: float = 30, attempts: int = 3) -> dict:
    """Return validated settlements for all listed maturities and selectable dates.

    `available_trade_dates` only includes dates with complete published settlements.
    Current intraday dates whose Settle cells are all N/A appear in
    `unpublished_dates`/`skipped`; they cannot advance the latest settlement date.
    """
    if not 1 <= attempts <= 3 or timeout <= 0:
        raise ValueError("Use 1–3 attempts and a positive request timeout.")
    page = _request(SOURCE_URL, None, timeout=timeout, attempts=attempts)
    selection = parse_selection_page(page["body"])
    raw_responses = [page]
    rows, statuses = [], []
    for date in sorted(selection["trade_dates"], key=lambda value: value["date"]):
        payload = {"mt": "M", "md[]": [m["value"] for m in selection["maturities"]], "td": date["value"]}
        response = _request(TABLE_URL, payload, timeout=timeout, attempts=attempts)
        raw_responses.append(response)
        values, status = parse_settlement_table(response["body"], date["date"], selection["maturities"])
        rows.extend(values)
        statuses.append(status)
    if not rows:
        raise SourceError("No published settlement rows in any selectable trade date.")
    keys = [(row["date"], row["contract"]) for row in rows]
    if len(keys) != len(set(keys)):
        raise SourceError("Duplicate date/contract records in collection.")
    rows.sort(key=lambda row: (row["date"], row["delivery_year"], MONTH_NUMBER[row["month"].lower()]))
    skipped = [status for status in statuses if status["status"] == "unpublished"]
    return {"rows": rows, "raw_responses": raw_responses,
            "available_trade_dates": sorted({row["date"] for row in rows}),
            "selectable_trade_dates": sorted(date["date"] for date in selection["trade_dates"]),
            "unpublished_dates": [status["date"] for status in skipped], "skipped": skipped,
            "table_status": statuses, "source_url": SOURCE_URL,
            "notes": ["Price is the official table Settle field in EUR/tonne, never Last.",
                      "ML month-code/year symbols are canonical local aliases for the explicitly labelled EBM delivery.",
                      "Open interest is the source table value; Euronext notes previous-business-day activity and overnight/morning offsets, so its timing differs from settlement publication.",
                      "Only the source's selectable recent dates are available; this endpoint is not a historical backfill API.",
                      f"Website automation/redistribution rights are separate from public access; review {TERMS_URL}. NextHistory EOD is the supported credentialed alternative."]}


if __name__ == "__main__":
    result = collect()
    print(json.dumps({key: value for key, value in result.items() if key != "raw_responses"}, indent=2))
