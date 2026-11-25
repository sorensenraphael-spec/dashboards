(async function(){
const el=id=>document.getElementById(id);if(!el('su-section'))return;
const fmt=(x,n=1)=>Number.isFinite(x)?x.toFixed(n):'n/a';
try{
 const response=await fetch('wheat/stocks_use.json',{cache:'no-cache'});if(!response.ok)throw Error('HTTP '+response.status);
 const data=await response.json(), yr=data.currentYear;
 const week=el('su-week'), mode=el('su-mode'), ref=el('su-reference'), point=el('su-point');
 const maxWeek=Math.max(...data.panels.flatMap(p=>p.records.map(r=>r.week)));
 const currentWeek=Math.max(...data.panels.flatMap(p=>p.records.filter(r=>r.year===yr).map(r=>r.week)));
 for(let w=0;w<=maxWeek;w++){
  const dt=new Date(Date.UTC(2000,8,1+7*w)),o=document.createElement('option');o.value=w;
  o.textContent=dt.toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'})+(w===currentWeek?' (current week)':'');week.append(o);
 }week.value=currentWeek;
 const cards=data.panels.map(p=>{
  const c=document.createElement('article');c.className='chart-card';
  const h=document.createElement('h2');h.style.fontSize='16px';h.textContent=p.group+' - '+p.title;
  const chart=document.createElement('div');chart.className='chart'; const caption=document.createElement('p');caption.className='chart-caption';
  c.append(h,chart,caption);el('su-panels').append(c);return {p,chart,caption};
 });
 const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
 function regression(rows){
  if(rows.length<5)return null;
  const mx=mean(rows.map(r=>r.x)),my=mean(rows.map(r=>r.spread));
  const xx=rows.reduce((s,r)=>s+(r.x-mx)**2,0),yy=rows.reduce((s,r)=>s+(r.spread-my)**2,0);
  const xy=rows.reduce((s,r)=>s+(r.x-mx)*(r.spread-my),0);
  if(!xx||!yy)return null;
  return {b:xy/xx,a:my-xy/xx*mx,r2:xy**2/(xx*yy)};
 }
 function render(){
  const w=+week.value,kind=mode.value,period=ref.value;
  const xlabel=kind==='old'?'Current marketing year stocks/use (%)':kind==='new'?'Next marketing year stocks/use (%)':'Current minus next stocks/use (pp)';
  for(const {p,chart,caption} of cards){
   const rows=p.records.filter(r=>r.week===w&&(kind==='old'||r.new!==null)).map(r=>({...r,x:kind==='old'?r.old:kind==='new'?r.new:r.old-r.new}));
   let hist=rows.filter(r=>r.year<yr);if(period!=='all')hist=hist.filter(r=>r.year>=yr-Number(period));
   const latest=p.records.filter(r=>r.year===yr).sort((a,b)=>a.week-b.week).at(-1);
   const fixed=point.value==='fixed';
   const cur=fixed?(latest&&(kind==='old'||latest.new!==null)?{...latest,x:kind==='old'?latest.old:kind==='new'?latest.new:latest.old-latest.new}:null):rows.find(r=>r.year===yr);
   const fit=regression(hist),traces=[];
   const trace=(r,name,color,size)=>({type:'scatter',mode:'markers',name,x:r.map(z=>z.x),y:r.map(z=>z.spread),customdata:r.map(z=>[z.year,z.report,z.old,z.new]),marker:{size,color,opacity:.85,line:{width:1,color:'#141821'}},hovertemplate:'Crop %{customdata[0]}<br>WASDE %{customdata[1]}<br>Current MY S/U %{customdata[2]:.2f}%<br>Next MY S/U %{customdata[3]}<br>Spread %{y:.1f} c/bu<extra></extra>'});
   if(hist.length)traces.push(trace(hist,'Prior years','#8fcbd3',9));
   if(fit){const xs=[Math.min(...hist.map(r=>r.x)),Math.max(...hist.map(r=>r.x))];traces.push({type:'scatter',mode:'lines',name:'OLS fit (prior years)',x:xs,y:xs.map(x=>fit.a+fit.b*x),line:{color:'#aab4c5',dash:'dot'},hoverinfo:'skip'});}
   if(cur)traces.push(trace([cur],String(yr)+(fixed?' latest (fixed)':' selected week'),'#ff806b',14));
   const expected=cur&&fit?fit.a+fit.b*cur.x:null;
   const extrap=cur&&hist.length&&(cur.x<Math.min(...hist.map(r=>r.x))||cur.x>Math.max(...hist.map(r=>r.x)));
   Plotly.react(chart,traces,{paper_bgcolor:'#141821',plot_bgcolor:'#141821',font:{family:'system-ui',color:'#b7c0cc',size:12},margin:{l:65,r:18,t:10,b:85},xaxis:{title:xlabel,gridcolor:'#252c37'},yaxis:{title:'Old minus new (c/bu)',gridcolor:'#252c37',zerolinecolor:'#596372'},legend:{orientation:'h',y:-.25},annotations:traces.length?[]:[{text:'No matched observations for this week',xref:'paper',yref:'paper',x:.5,y:.5,showarrow:false}]},{responsive:true,displaylogo:false});
   caption.textContent=p.balance+' | n='+hist.length+(fit?' | R² '+fmt(fit.r2,2)+' | slope '+fmt(fit.b,2):'')+(cur?' | '+(fixed?'Fixed latest week '+cur.date:yr+' selected week')+': '+fmt(cur.x,2)+(kind==='gap'?' pp':'%')+', '+fmt(cur.spread)+' c/bu (WASDE '+cur.report+')':' | Current crop unavailable')+(expected!==null?' | Fitted '+fmt(expected)+' c/bu | residual '+fmt(cur.spread-expected)+' c/bu':'')+(extrap?' | Outside historical S/U range':'');
  }
 }
 week.onchange=mode.onchange=ref.onchange=point.onchange=render;el('su-status').textContent='Latest WASDE in archive: '+data.lastWasde;render();
}catch(e){el('su-status').textContent='Stocks/use data unavailable: '+e.message;}
})();
