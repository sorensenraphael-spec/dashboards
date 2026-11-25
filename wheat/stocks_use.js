(async function(){
const el=id=>document.getElementById(id);if(!el('su-section'))return;
const fmt=(x,n=1)=>Number.isFinite(x)?x.toFixed(n):'n/a';
try{
 const response=await fetch('wheat/stocks_use.json',{cache:'no-cache'});if(!response.ok)throw Error('HTTP '+response.status);
 const data=await response.json(), yr=data.currentYear;
 const week=el('su-week'), mode=el('su-mode'), ref=el('su-reference'), point=el('su-point'), model=el('su-model'), picker=el('su-years');
 const maxWeek=Math.max(...data.panels.flatMap(p=>p.records.map(r=>r.week)));
 const currentWeek=Math.max(...data.panels.flatMap(p=>p.records.filter(r=>r.year===yr).map(r=>r.week)));
 for(let w=0;w<=maxWeek;w++){
  const dt=new Date(Date.UTC(2000,8,1+7*w)),o=document.createElement('option');o.value=w;
  o.textContent=dt.toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'})+(w===currentWeek?' (current week)':'');week.append(o);
 }week.value=currentWeek;
 const years=[...new Set(data.panels.flatMap(p=>p.records.map(r=>r.year)))].filter(y=>y<yr).sort((a,b)=>a-b);
 const selected=new Set(years);
 for(const y of years){const label=document.createElement('label'), c=document.createElement('input');c.type='checkbox';c.value=y;c.checked=true;c.onchange=()=>{c.checked?selected.add(y):selected.delete(y);render();};label.append(c,document.createTextNode(String(y)));picker.append(label);}
 function resetYears(){const period=ref.value;selected.clear();for(const y of years)if(period==='all'||y>=yr-Number(period))selected.add(y);picker.querySelectorAll('input').forEach(c=>c.checked=selected.has(+c.value));render();}
 el('su-all-years').onclick=()=>{ref.value='all';resetYears();};
 el('su-no-years').onclick=()=>{selected.clear();picker.querySelectorAll('input').forEach(c=>c.checked=false);render();};
 const cards=data.panels.map(p=>{
  const c=document.createElement('article');c.className='chart-card';
  const h=document.createElement('h2');h.style.fontSize='16px';h.textContent=p.group+' - '+p.title;
  const chart=document.createElement('div');chart.className='chart'; const caption=document.createElement('p');caption.className='chart-caption';
  c.append(h,chart,caption);el('su-panels').append(c);return {p,chart,caption};
 });
 const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
 const models=[
 {id:'linear',name:'Linear',f:x=>[1,x]},
 {id:'inverse',name:'Inverse (1/SU)',f:x=>x>0?[1,1/x]:null},
 {id:'log',name:'Logarithmic',f:x=>x>0?[1,Math.log(x)]:null},
 {id:'quadratic',name:'Quadratic',f:x=>[1,x,x*x]},
 ...[0.05,0.1,0.2,0.35].map(k=>({id:'exp'+k,name:'Exponential (k='+k+')',f:x=>[1,Math.exp(-k*x)]}))
 ];
 function solve(A,b){const n=b.length;A=A.map((r,i)=>[...r,b[i]]);for(let i=0;i<n;i++){let j=i;for(let k=i+1;k<n;k++)if(Math.abs(A[k][i])>Math.abs(A[j][i]))j=k;[A[i],A[j]]=[A[j],A[i]];if(Math.abs(A[i][i])<1e-10)return null;const z=A[i][i];for(let k=i;k<=n;k++)A[i][k]/=z;for(let j=0;j<n;j++)if(j!==i){const z=A[j][i];for(let k=i;k<=n;k++)A[j][k]-=z*A[i][k];}}return A.map(r=>r[n]);}
 function fitModel(rows,m){
  const X=rows.map(r=>m.f(r.x));if(X.some(x=>!x||x.some(v=>!Number.isFinite(v))))return null;
  const k=X[0].length;if(rows.length<k+2)return null;
  const A=Array.from({length:k},(_,i)=>Array.from({length:k},(_,j)=>X.reduce((v,x)=>v+x[i]*x[j],0)));
  const b=Array.from({length:k},(_,i)=>X.reduce((v,x,j)=>v+x[i]*rows[j].spread,0));
  const beta=solve(A,b);if(!beta)return null;
  const predict=x=>{const f=m.f(x);return f?f.reduce((v,z,i)=>v+z*beta[i],0):NaN;};
  return predict;
 }
 function regression(rows,choice){
  if(rows.length<5)return null;
  const my=mean(rows.map(r=>r.spread)),sst=rows.reduce((v,r)=>v+(r.spread-my)**2,0);
  if(!sst)return null;
  const candidates=models.filter(m=>choice==='auto'||m.id===choice||(choice==='exp'&&m.id.startsWith('exp')));
  const fits=[];
  for(const m of candidates){
   const predict=fitModel(rows,m);if(!predict)continue;
   let err=0,valid=true;
   for(let i=0;i<rows.length;i++){const f=fitModel(rows.filter((_,j)=>i!==j),m),p=f?f(rows[i].x):NaN;if(!Number.isFinite(p)){valid=false;break;}err+=(p-rows[i].spread)**2;}
   if(!valid)continue;
   const cv=Math.sqrt(err/rows.length),r2=1-rows.reduce((v,r)=>v+(predict(r.x)-r.spread)**2,0)/sst;
   fits.push({name:m.name,id:m.id,predict,cv,r2});
  }
  return fits.sort((a,b)=>a.cv-b.cv)[0]||null;
 }
 function render(){
  const w=+week.value,kind=mode.value,period=ref.value;
  const xlabel=kind==='old'?'Current marketing year stocks/use (%)':kind==='new'?'Next marketing year stocks/use (%)':'Current minus next stocks/use (pp)';
  for(const {p,chart,caption} of cards){
   const rows=p.records.filter(r=>r.week===w&&(kind==='old'||r.new!==null)).map(r=>({...r,x:kind==='old'?r.old:kind==='new'?r.new:r.old-r.new}));
   let hist=rows.filter(r=>r.year<yr&&selected.has(r.year));
   const latest=p.records.filter(r=>r.year===yr).sort((a,b)=>a.week-b.week).at(-1);
   const fixed=point.value==='fixed';
   const cur=fixed?(latest&&(kind==='old'||latest.new!==null)?{...latest,x:kind==='old'?latest.old:kind==='new'?latest.new:latest.old-latest.new}:null):rows.find(r=>r.year===yr);
   const fit=regression(hist,model.value),traces=[];
   const trace=(r,name,color,size)=>({type:'scatter',mode:'markers',name,x:r.map(z=>z.x),y:r.map(z=>z.spread),customdata:r.map(z=>[z.year,z.report,z.old,z.new]),marker:{size,color,opacity:.85,line:{width:1,color:'#141821'}},hovertemplate:'Crop %{customdata[0]}<br>WASDE %{customdata[1]}<br>Current MY S/U %{customdata[2]:.2f}%<br>Next MY S/U %{customdata[3]}<br>Spread %{y:.1f} c/bu<extra></extra>'});
   if(hist.length)traces.push(trace(hist,'Prior years','#8fcbd3',9));
   if(fit){const lo=Math.min(...hist.map(r=>r.x)),hi=Math.max(...hist.map(r=>r.x));const xs=Array.from({length:101},(_,i)=>lo+(hi-lo)*i/100);traces.push({type:'scatter',mode:'lines',name:fit.name+' fit',x:xs,y:xs.map(fit.predict),line:{color:'#aab4c5',dash:'dot'},hoverinfo:'skip'});}
   if(cur)traces.push(trace([cur],String(yr)+(fixed?' latest (fixed)':' selected week'),'#ff806b',14));
   const expected=cur&&fit?fit.predict(cur.x):null;
   const extrap=cur&&hist.length&&(cur.x<Math.min(...hist.map(r=>r.x))||cur.x>Math.max(...hist.map(r=>r.x)));
   Plotly.react(chart,traces,{paper_bgcolor:'#141821',plot_bgcolor:'#141821',font:{family:'system-ui',color:'#b7c0cc',size:12},margin:{l:65,r:18,t:10,b:85},xaxis:{title:xlabel,gridcolor:'#252c37'},yaxis:{title:'Old minus new (c/bu)',gridcolor:'#252c37',zerolinecolor:'#596372'},legend:{orientation:'h',y:-.25},annotations:traces.length?[]:[{text:'No matched observations for this week',xref:'paper',yref:'paper',x:.5,y:.5,showarrow:false}]},{responsive:true,displaylogo:false});
   caption.textContent=p.balance+' | n='+hist.length+(fit?' | R² '+fmt(fit.r2,2)+' | '+fit.name+' | LOYO RMSE '+fmt(fit.cv,1)+' c/bu':'')+(cur?' | '+(fixed?'Fixed latest week '+cur.date:yr+' selected week')+': '+fmt(cur.x,2)+(kind==='gap'?' pp':'%')+', '+fmt(cur.spread)+' c/bu (WASDE '+cur.report+')':' | Current crop unavailable')+(expected!==null?' | Fitted '+fmt(expected)+' c/bu | residual '+fmt(cur.spread-expected)+' c/bu':'')+(extrap?' | Outside historical S/U range':'');
  }
 }
 week.onchange=mode.onchange=point.onchange=model.onchange=render;ref.onchange=resetYears;el('su-status').textContent='Latest WASDE in archive: '+data.lastWasde;render();
}catch(e){el('su-status').textContent='Stocks/use data unavailable: '+e.message;}
})();
