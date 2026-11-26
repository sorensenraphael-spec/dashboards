/* MATIF December minus following March, from the existing daily settlement snapshot. */
(async function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = $('chart-decmar');
  if (!root) return;
  const DAY = 86400000;
  const seasonStart = year => Date.UTC(year - 1, 11, 1);
  const seasonalDay = date => {
    const [, month, day] = date.split('-').map(Number);
    return (Date.UTC(month === 12 ? 1999 : 2000, month - 1, day) - seasonStart(2000)) / DAY;
  };
  const fmtDay = day => new Date(seasonStart(2000) + day * DAY).toLocaleDateString('en-GB', {day:'numeric', month:'short', timeZone:'UTC'});
  const quantile = (values, q) => {
    const a = [...values].sort((a,b) => a-b), i = (a.length-1)*q;
    return a[Math.floor(i)] + (a[Math.ceil(i)]-a[Math.floor(i)])*(i%1);
  };
  const mean = a => a.reduce((s,v) => s+v,0)/a.length;
  const pairLabel = year => 'Dec ' + year + ' / Mar ' + (year+1);
  try {
    const [response, archiveResponse] = await Promise.all([
      fetch('wheat/data/source/matif_all_contracts.csv', {cache:'no-store'}),
      fetch('wheat/decmar_history.json', {cache:'no-store'})
    ]);
    if (!response.ok || !archiveResponse.ok) throw Error('December/March settlement data unavailable.');
    const archive = await archiveResponse.json();
    if (archive.schemaVersion !== 1 || !Array.isArray(archive.series)) throw Error('Unexpected December/March archive format.');
    // This source is a generated numeric CSV with unquoted ISO dates and contract identifiers.
    const lines = (await response.text()).trim().split(/\r?\n/);
    const header = lines.shift().replace(/^\uFEFF/, '').split(',');
    for (const field of ['date','contract','month','delivery_year','matif_eur_t']) {
      if (!header.includes(field)) throw Error('Unexpected MATIF data format.');
    }
    const rows = lines.filter(Boolean).map(line => Object.fromEntries(line.split(',').map((value,i) => [header[i],value])));
    const keys = new Set(), contracts = new Map();
    let asOf = '';
    for (const row of rows) {
      if (!['Dec','Mar'].includes(row.month)) continue;
      const year = Number(row.delivery_year), price = Number(row.matif_eur_t);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isInteger(year) || !row.matif_eur_t || !Number.isFinite(price) || price <= 0) throw Error('Invalid MATIF settlement row.');
      const key = row.month + ':' + year + ':' + row.date;
      if (keys.has(key)) throw Error('Duplicate MATIF settlement date and delivery.');
      keys.add(key);
      const contractKey = row.month + ':' + year;
      if (contracts.has(contractKey) && contracts.get(contractKey) !== row.contract) throw Error('Conflicting MATIF contract identifiers.');
      contracts.set(contractKey, row.contract);
      if (row.date > asOf) asOf = row.date;
    }
    const march = new Map(rows.filter(r => r.month === 'Mar').map(r => [r.delivery_year + ':' + r.date, r]));
    const groups = new Map();
    function addPoint(year, date, dec, mar) {
      if (!Number.isInteger(year) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || ![dec,mar].every(p=>Number.isFinite(p)&&p>0)) throw Error('Invalid archived MATIF pair.');
      if (date < (year-1)+'-12-01' || date >= year+'-12-01') throw Error('Archived observation outside its delivery season.');
      if (!groups.has(year)) groups.set(year, []);
      const points = groups.get(year), index = points.findIndex(p=>p.date===date);
      const point = {date, x:seasonalDay(date), y:dec-mar, dec, mar};
      if (index < 0) points.push(point); else points[index] = point;
    }
    for (const season of archive.series) {
      for (const [date,dec,mar] of season.points) addPoint(season.year,date,dec,mar);
    }
    for (const dec of rows.filter(r => r.month === 'Dec')) {
      const year = Number(dec.delivery_year), mar = march.get((year+1) + ':' + dec.date);
      // One fixed pair per season; stop before the December delivery month.
      if (!mar || dec.date < (year-1)+'-12-01' || dec.date >= year+'-12-01') continue;
      // Published Euronext revisions take precedence over workbook overlaps.
      addPoint(year, dec.date, Number(dec.matif_eur_t), Number(mar.matif_eur_t));
    }
    const current = Number(asOf.slice(0,4)) + (asOf.slice(5,7) === '12' ? 1 : 0);
    const series = [...groups].sort((a,b) => a[0]-b[0]).map(([year, points]) => {
      points.sort((a,b) => a.date.localeCompare(b.date));
      const weeks = new Map();
      for (const p of points) {
        const week = Math.floor(p.x/7);
        if (!weeks.has(week)) weeks.set(week, []);
        weeks.get(week).push(p);
      }
      return {year, points, weeks:[...weeks].map(([w,ps]) => ({x:w*7+3,w,y:mean(ps.map(p=>p.y))})),
        complete:year<current && points.length>=180 && points[0].date<=(year-1)+'-12-15' && points.at(-1).date>=year+'-11-15'};
    });
    if (!series.length) throw Error('No same-date December / following-March settlements are available.');
    const selected = new Set(series.filter(s=>s.year>=current-5).map(s=>s.year));
    if (!selected.size) selected.add(series.at(-1).year);
    const latestSeries = series.find(s=>s.year===current) || series.at(-1);
    const latest = latestSeries.points.at(-1);
    function render() {
      const change = $('decmar-mode').value === 'change';
      const frequency = $('decmar-frequency').value;
      const windowMode = $('decmar-window').value;
      const reference = $('history').value;
      let history = series.filter(s=>s.complete);
      if (reference === 'recent10') history = history.slice(-10);
      else if (reference === 'post2010') history = history.filter(s=>s.year>=2010);
      const getPoints = s => {
        const ps = frequency === 'daily' ? s.points : s.weeks;
        return ps.map(p=>({...p,y:p.y-(change?ps[0].y:0)}));
      };
      const byWeek = new Map();
      for (const s of history) {
        const anchor = frequency==='daily' ? s.points[0].y : s.weeks[0].y;
        for (const p of s.weeks) {
          if (!byWeek.has(p.x)) byWeek.set(p.x, []);
          byWeek.get(p.x).push(p.y-(change?anchor:0));
        }
      }
      const band = [...byWeek].sort((a,b)=>a[0]-b[0]).filter(([,values])=>values.length>=3);
      const traces = [];
      if (band.length) {
        for (const [q,name,fill] of [[.25,'',false],[.75,'Historical 25–75%',true],[.5,'Historical median',false]]) {
          traces.push({x:band.map(p=>p[0]),y:band.map(p=>quantile(p[1],q)),mode:'lines',name,showlegend:q!==.25,
            line:{color:'#8fcbd3',width:q===.5?2.5:0,dash:'dot'},...(fill?{fill:'tonexty',fillcolor:'rgba(99,165,183,.13)'}:{})});
        }
      }
      for (const s of series.filter(s=>selected.has(s.year))) {
        const ps=getPoints(s), xs=[], ys=[], labels=[];
        ps.forEach((p,i)=>{
          if(i && p.x-ps[i-1].x>8){xs.push((p.x+ps[i-1].x)/2);ys.push(null);labels.push('');}
          xs.push(p.x);ys.push(p.y);labels.push(frequency==='daily'?p.date:'Week of '+fmtDay(p.w*7));
        });
        traces.push({x:xs,y:ys,customdata:labels,type:'scatter',mode:'lines+markers',name:pairLabel(s.year)+(s.year===current?' · current':''),
          line:{color:s.year===current?'#ff806b':undefined,width:s.year===current?3:1.4},
          marker:{size:ps.length<30?7:3},connectgaps:false,
          hovertemplate:'%{customdata}<br>%{y:.2f} EUR/t<extra>'+pairLabel(s.year)+'</extra>'});
      }
      const xs=traces.flatMap(t=>t.x);
      const range=windowMode==='available'&&xs.length?[Math.max(0,Math.min(...xs)-3),Math.min(366,Math.max(...xs)+3)]:[0,366];
      const short=range[1]-range[0]<60;
      const ticks=short?Array.from({length:367},(_,i)=>i).filter(i=>i>=range[0]&&i<=range[1]&&i%3===0):[0,31,62,91,122,152,183,213,244,275,305,336];
      Plotly.react(root,traces,{
        paper_bgcolor:'#141821',plot_bgcolor:'#141821',font:{family:'system-ui',color:'#b7c0cc',size:13},
        margin:{l:66,r:18,t:16,b:74},
        xaxis:{range,tickvals:ticks,ticktext:short?ticks.map(fmtDay):['Dec','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov'],gridcolor:'#252c37'},
        yaxis:{title:(change?'Change · ':'')+'EUR/t',gridcolor:'#252c37',zerolinecolor:'#596372'},
        legend:{orientation:'h',y:-.18},uirevision:[change,frequency,windowMode,reference,[...selected]].join(':'),
        annotations:xs.length?[]:[{text:'Select a contract pair to display',xref:'paper',yref:'paper',x:.5,y:.5,showarrow:false}]
      },{responsive:true,displaylogo:false});
      $('decmar-status').textContent=pairLabel(latestSeries.year)+' · '+(latest.y>0?'+':'')+latest.y.toFixed(2)+' EUR/t';
      const week=Math.floor(latest.x/7);
      const sample=history.map(s=>s.weeks.find(p=>p.w===week)?.y).filter(Number.isFinite);
      const pct=sample.length>=3?Math.round(100*(sample.filter(v=>v<latest.y).length+.5*sample.filter(v=>v===latest.y).length)/sample.length)+'% (n='+sample.length+')':'unavailable — insufficient paired history';
      $('caption-decmar').textContent='Latest matched settlement '+latest.date+': December '+latest.dec.toFixed(2)+' minus March '+latest.mar.toFixed(2)+' = '+latest.y.toFixed(2)+' EUR/t. '+latestSeries.points.length+' matched days since '+latestSeries.points[0].date+'. Same-week percentile: '+pct+'. '+history.length+' completed reference seasons. '+(history.length<3?'No historical band until at least three complete seasons are available. ':'')+(change?'Change is measured from each line’s first available '+(frequency==='daily'?'settlement':'weekly mean')+'; partial-season anchors can differ.':'');
    }
    for(const s of series){
      const label=document.createElement('label'), input=document.createElement('input');
      input.type='checkbox';input.checked=selected.has(s.year);
      input.addEventListener('change',()=>{input.checked?selected.add(s.year):selected.delete(s.year);render();});
      label.append(input,document.createTextNode(' '+pairLabel(s.year)+' '));$('decmar-years').append(label);
    }
    for(const id of ['decmar-mode','decmar-frequency','decmar-window','history']) $(id).addEventListener('change',render);
    render();
  } catch(error) {
    root.textContent=error.message;
    $('decmar-status').textContent='Data unavailable';
    $('decmar-status').classList.remove('available');
  }
})();
