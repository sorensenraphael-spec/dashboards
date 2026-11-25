(async function(){
const el=id=>document.getElementById(id), host=el('es-panels');if(!host)return;
const fmt=x=>Number(x).toFixed(2);
try{
const res=await fetch('wheat/export_sales.json',{cache:'no-cache'});if(!res.ok)throw Error('HTTP '+res.status);
const data=await res.json(), years=[...new Set(data.panels.flatMap(p=>p.seasons.map(s=>s.year)))].sort((a,b)=>a-b);
const selected=new Set(years.slice(-4)),picker=el('es-years');
for(const y of years){const l=document.createElement('label'),c=document.createElement('input');c.type='checkbox';c.value=y;c.checked=selected.has(y);c.onchange=()=>{c.checked?selected.add(y):selected.delete(y);render();};l.append(c,document.createTextNode(y+'/'+String(y+1).slice(-2)));picker.append(l);}
el('es-all').onclick=()=>{years.forEach(y=>selected.add(y));picker.querySelectorAll('input').forEach(c=>c.checked=true);render();};
el('es-recent').onclick=()=>{selected.clear();years.slice(-4).forEach(y=>selected.add(y));picker.querySelectorAll('input').forEach(c=>c.checked=selected.has(+c.value));render();};
el('es-history').onchange=render;
const cards=[];
for(const p of data.panels){
 const sec=document.createElement('section');sec.style.margin='24px 0';
 const h=document.createElement('h2');h.textContent=p.name;sec.append(h);
 const summary=document.createElement('p');summary.className='summary-note';sec.append(summary);
 const grid=document.createElement('div');grid.className='spread-grid';sec.append(grid);host.append(sec);
 const chartlist=[];
 for(const [key,title] of [['sales','Weekly net export sales'],['commit','Total export commitments (shipped + outstanding)'],['weeklyShip','Weekly shipments'],['ship','Accumulated shipments']]){
  const card=document.createElement('article');card.className='chart-card';const titleEl=document.createElement('h2');titleEl.style.fontSize='16px';titleEl.textContent=title;const chart=document.createElement('div');chart.className='chart';card.append(titleEl,chart);grid.append(card);chartlist.push({key,chart});
 }
 cards.push({p,summary,chartlist});
}
const quant=(a,q)=>{a=[...a].sort((x,y)=>x-y);const i=(a.length-1)*q;return a.length?a[Math.floor(i)]+(a[Math.ceil(i)]-a[Math.floor(i)])*(i%1):null;};
function render(){
 for(const {p,summary,chartlist} of cards){
  const cur=p.seasons.find(s=>s.year===p.current),last=cur.points.at(-1);
  const period=el('es-history').value;let hist=p.seasons.filter(s=>s.year<p.current);if(period!=='all')hist=hist.slice(-Number(period));
  const same=hist.flatMap(s=>s.points.filter(z=>z.w===last.w).map(z=>z.commit));
  const pct=same.length?100*same.filter(x=>x<last.commit).length/same.length:null;
  summary.textContent='Week ending '+last.date+' | WASDE '+p.wasde+': '+fmt(p.target)+' MMT | commitments '+fmt(last.commit)+' MMT ('+fmt(100*last.commit/p.target)+'% of target) | shipments '+fmt(last.ship)+' MMT | remaining '+fmt(p.remainingWeeks)+' weeks | net sales needed '+fmt(p.required)+' MMT/wk vs last 4wk '+fmt(p.last4)+' | shipments needed '+fmt(p.shipRequired)+' MMT/wk vs last 4wk '+fmt(p.last4Ship)+' | historical commitments percentile '+(pct===null?'n/a':fmt(pct)+'%');
  for(const {key,chart} of chartlist){
   const maxW=Math.max(52,...p.seasons.flatMap(s=>s.points.map(z=>z.w))),xs=Array.from({length:maxW},(_,i)=>i+1);
   const buckets=xs.map(w=>hist.flatMap(s=>s.points.filter(z=>z.w===w).map(z=>z[key])));
   const qs=q=>buckets.map(a=>a.length>=3?quant(a,q):null);
   const traces=[{x:xs,y:qs(.25),mode:'lines',line:{width:0},showlegend:false,hoverinfo:'skip'},{x:xs,y:qs(.75),mode:'lines',line:{width:0},fill:'tonexty',fillcolor:'rgba(99,165,183,.14)',name:'25-75% range'},{x:xs,y:qs(.5),mode:'lines',line:{color:'#8fcbd3',dash:'dot',width:2},name:'Historical median'}];
   for(const s of p.seasons.filter(s=>selected.has(s.year)||s.year===p.current))traces.push({x:s.points.map(z=>z.w),y:s.points.map(z=>z[key]),customdata:s.points.map(z=>z.date),mode:'lines',name:s.year+'/'+String(s.year+1).slice(-2),line:{width:s.year===p.current?3:1,color:s.year===p.current?'#ff806b':undefined},opacity:s.year===p.current?1:.6,hovertemplate:'%{customdata}<br>%{y:.2f} MMT<extra></extra>'});
   const weekly=key==='sales'||key==='weeklyShip',required=key==='sales'||key==='commit'?p.required:p.shipRequired;
   if(weekly){
    traces.push({x:[last.w,52],y:[required,required],mode:'lines',name:'Required remaining pace',line:{color:'#e0b96d',dash:'dash',width:2}});
    const rolling=cur.points.map((z,i)=>i>=3?cur.points.slice(i-3,i+1).reduce((a,b)=>a+b[key],0)/4:null);
    traces.push({x:cur.points.map(z=>z.w),y:rolling,mode:'lines',name:'Current 4-week average',line:{color:'#ffcfad',dash:'dot',width:2}});
   }else{
    traces.push({x:[last.w,Math.max(last.w+1,52)],y:[last[key],p.target],mode:'lines',name:'Required path to WASDE',line:{color:'#e0b96d',dash:'dash',width:2}});
    traces.push({x:[1,52],y:[p.target,p.target],mode:'lines',name:'WASDE target',line:{color:'#e0b96d',dash:'dot',width:1}});
   }
   Plotly.react(chart,traces,{paper_bgcolor:'#141821',plot_bgcolor:'#141821',font:{family:'system-ui',color:'#b7c0cc',size:12},margin:{l:60,r:16,t:10,b:78},xaxis:{title:'Marketing year week',range:[1,maxW],gridcolor:'#252c37'},yaxis:{title:weekly?'MMT / week':'MMT',gridcolor:'#252c37'},legend:{orientation:'h',y:-.25},hovermode:'closest'},{responsive:true,displaylogo:false});
  }
 }
}
el('es-status').textContent='Latest week ending '+data.panels.map(p=>p.seasons.at(-1).points.at(-1).date).sort()[0]+' | USDA FAS via public archive';render();
}catch(e){el('es-status').textContent='Export sales unavailable: '+e.message;}
})();
