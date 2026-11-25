/* Grain seasonal extension. Weekly derived data; separate controls from March wheat. */
(async function(){
'use strict';
const el=id=>document.getElementById(id);
const host=el('grain-seasonals');
if(!host)return;
const q=(a,p)=>{if(!a.length)return null; a=[...a].sort((x,y)=>x-y); const n=(a.length-1)*p,i=Math.floor(n);return a[i]+(a[Math.ceil(n)]-a[i])*(n-i);};
const fmt=(v,d=1)=>v==null?'n/a':Number(v).toFixed(d);
const colors=['#587786','#8c80ac','#589d97','#b68b62','#5f8caf','#aa7d95','#88a273','#a2a9ba'];
try{
const res=await fetch('wheat/grain_seasonals.json',{cache:'no-cache'});if(!res.ok)throw Error('HTTP '+res.status);
const data=await res.json(); const current=data.currentYear;
const years=[...new Set(data.panels.flatMap(p=>p.series.map(s=>s.year)))].sort((a,b)=>a-b);
let selected=new Set(years.slice(-4)); 
const picker=el('grain-years');
for(const y of years){
 const l=document.createElement('label'), c=document.createElement('input');c.type='checkbox';c.checked=selected.has(y);c.value=y;
 c.addEventListener('change',()=>{c.checked?selected.add(y):selected.delete(y);render();});
 l.append(c,document.createTextNode(String(y)+(y===current?' current':'')));picker.append(l);
}
for(const [id,which] of [['grain-recent',()=>years.slice(-4)],['grain-all',()=>years],['grain-none',()=>[]]]){
 el(id).onclick=()=>{selected=new Set(which());picker.querySelectorAll('input').forEach(c=>c.checked=selected.has(+c.value));render();};
}
el('grain-history').onchange=render;
const cards=[];
for(const group of ['Corn','Soybeans','Wheat']){
 const section=document.createElement('section');section.style.margin='24px 0';
 const heading=document.createElement('div');heading.className='section-heading spread-section-heading';const h=document.createElement('h2');h.textContent=group==='Wheat'?'Wheat old / new crop':group;heading.append(h);section.append(heading);
 const grid=document.createElement('div');grid.className='spread-grid';section.append(grid);el('grain-panels').append(section);
 for(const p of data.panels.filter(p=>p.group===group)){
  const card=document.createElement('article');card.className='chart-card';
  const head=document.createElement('div');head.className='card-heading';
  const title=document.createElement('h2');title.textContent=p.title;head.append(title);
  const caption=document.createElement('p');caption.className='chart-caption';
  const chart=document.createElement('div');chart.className='chart';chart.setAttribute('aria-label',group+' '+p.title+' seasonal chart');
  card.append(head,chart,caption);grid.append(card);cards.push({p,chart,caption});
 }
}
function render(){
 const period=el('grain-history').value;
 for(const {p,chart,caption} of cards){
  let hist=p.series.filter(s=>s.complete&&s.year<current);
  if(period!=='all')hist=hist.slice(-Number(period));
  const maps=hist.map(s=>new Map(s.weeks));
  const end=Math.max(...p.series.flatMap(s=>s.weeks.map(w=>w[0])));
  const xs=Array.from({length:end+1},(_,i)=>i);
  const vals=xs.map(w=>maps.map(m=>m.get(w)).filter(Number.isFinite));
  const qs=prob=>vals.map(a=>a.length>=3?q(a,prob):null);
  const traces=[
   {x:xs,y:qs(.25),type:'scatter',mode:'lines',line:{width:0},showlegend:false,hoverinfo:'skip'},
   {x:xs,y:qs(.75),type:'scatter',mode:'lines',line:{width:0},fill:'tonexty',fillcolor:'rgba(99,165,183,.14)',name:'25-75% range',hoverinfo:'skip'},
   {x:xs,y:qs(.5),type:'scatter',mode:'lines',line:{color:'#8fcbd3',width:2.5,dash:'dot'},name:'Historical median',customdata:vals.map(a=>a.length),hovertemplate:'%{y:.1f} c/bu (%{customdata} years)<extra>Median</extra>'}
  ];
  for(const s of p.series.filter(s=>selected.has(s.year))){
   const map=new Map(s.weeks);traces.push({x:xs,y:xs.map(w=>map.get(w)??null),type:'scatter',mode:'lines',name:String(s.year)+(s.year===current?' current':''),line:{color:s.year===current?'#ff806b':colors[(s.year-2000)%colors.length],width:s.year===current?3:1.3},opacity:s.year===current?1:.65,connectgaps:false,hovertemplate:'%{y:.1f} c/bu<extra>'+s.year+'</extra>'});
  }
  const ticks=[], labels=[];for(let i=0;i<15;i++){const dt=new Date(Date.UTC(2000,8+i,1)),w=(dt-Date.UTC(2000,8,1))/604800000;if(w<=end+1){ticks.push(w);labels.push(dt.toLocaleString('en',{month:'short',timeZone:'UTC'}));}}
  Plotly.react(chart,traces,{paper_bgcolor:'#141821',plot_bgcolor:'#141821',font:{family:'system-ui, sans-serif',color:'#b7c0cc',size:12},margin:{l:64,r:15,t:14,b:70},xaxis:{range:[0,end+.5],tickvals:ticks,ticktext:labels,gridcolor:'#252c37'},yaxis:{title:p.mode==='spread'?'Old minus new (c/bu)':'Change from Sep start (c/bu)',gridcolor:'#252c37',zerolinecolor:'#596372'},legend:{orientation:'h',y:-.2},hovermode:'closest',uirevision:p.title+period},{responsive:true,displaylogo:false});
  const cur=p.series.find(s=>s.year===current), last=cur?.weeks.at(-1), sample=last?vals[last[0]]:[];
  const pct=sample?.length>=3?100*sample.reduce((n,v)=>n+(v<last[1]?1:v===last[1]?.5:0),0)/sample.length:null;
  caption.textContent=(cur?'Latest '+cur.last+': '+fmt(cur.latest,0)+' c/bu (rounded). '+(p.mode==='change'?'Change from Sep start: '+fmt(cur.latestChange)+' c/bu. ':'')+'Same-week percentile: '+(pct==null?'n/a':fmt(pct,0)+'%')+'. ':'Current season unavailable. ')+hist.length+' completed reference seasons'+(hist.length?' ('+hist[0].year+'-'+hist.at(-1).year+')':'')+'. Current week can be partial.';
 }
}
el('grain-status').textContent='Data through '+data.panels.map(p=>p.series.at(-1).last).sort()[0]+' or later; weekly means from fixed contracts. Crop year '+current+'.';
render();
}catch(e){el('grain-status').textContent='Grain seasonal data unavailable: '+e.message;}
})();
