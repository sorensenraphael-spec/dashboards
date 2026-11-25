(async function(){
  const $=id=>document.getElementById(id);
  const root=$('chart-september');
  if(!root)return;
  try{
    const res=await fetch('wheat/september_spread.json',{cache:'no-store'});
    if(!res.ok)throw Error('September spread data unavailable');
    const data=await res.json(), current=data.currentYear;
    const selected=new Set(data.series.filter(s=>s.year>=current-5).map(s=>s.year));
    const picker=$('sep-years');
    const quant=(a,q)=>{a=[...a].sort((a,b)=>a-b);const i=(a.length-1)*q;return a[Math.floor(i)]+(a[Math.ceil(i)]-a[Math.floor(i)])*(i%1);};
    function render(){
      const unit=$('unit').value, change=$('mode').value==='change', period=$('history').value;
      const label=unit==='eur'?'EUR/t':'USD/t';
      const points=s=>{const anchor=s.weeks.find(p=>p.w<=1);return change&&!anchor?[]:s.weeks.map(p=>({x:p.w*7+3,y:p[unit]-(change?anchor[unit]:0)}));};
      let hist=data.series.filter(s=>s.complete);
      if(period==='recent10')hist=hist.slice(-10);else if(period==='post2010')hist=hist.filter(s=>s.year>=2010);
      const by=new Map();for(const s of hist)for(const p of points(s)){if(!by.has(p.x))by.set(p.x,[]);by.get(p.x).push(p.y);}
      const b=[...by].sort((a,b)=>a[0]-b[0]).filter(([x,a])=>a.length>=3);
      const traces=[];
      if(b.length){
        for(const [q,name,fill] of [[.25,'',false],[.75,'25–75% range',true],[.5,'Historical median',false]])traces.push({x:b.map(v=>v[0]),y:b.map(v=>quant(v[1],q)),type:'scatter',mode:'lines',name,showlegend:q!==.25,line:{color:'#8fcbd3',width:q===.5?2.5:0,dash:'dot'},...(fill?{fill:'tonexty',fillcolor:'rgba(99,165,183,.13)'}:{})});
      }
      for(const s of data.series.filter(s=>selected.has(s.year))){
        const p=points(s);traces.push({x:p.map(v=>v.x),y:p.map(v=>v.y),type:'scatter',mode:'lines+markers',name:String(s.year)+(s.year===current?' current':''),line:{color:s.year===current?'#ff806b':undefined,width:s.year===current?3:1.3},marker:{size:4},connectgaps:false,hovertemplate:'%{y:.2f} '+label+'<extra>Sep '+s.year+'</extra>'});
      }
      Plotly.react(root,traces,{paper_bgcolor:'#141821',plot_bgcolor:'#141821',font:{family:'system-ui',color:'#b7c0cc',size:13},margin:{l:66,r:18,t:16,b:74},xaxis:{range:[0,365],tickvals:[0,30,61,91,122,153,181,212,242,273,303,334],ticktext:['Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug'],gridcolor:'#252c37'},yaxis:{title:(change?'Change since season start — ':'')+label,gridcolor:'#252c37',zerolinecolor:'#596372'},legend:{orientation:'h',y:-.15},uirevision:unit+change+period},{responsive:true,displaylogo:false});
      const s=data.series.find(s=>s.year===current);
      $('sep-status').textContent=s?'Sep '+current+' · '+s.latest[unit].toFixed(2)+' '+label:'Current contract unavailable';
      const week=s?.weeks.at(-1)?.w;
      const sample=hist.map(h=>h.weeks.find(p=>p.w===week)?.[unit]).filter(Number.isFinite);
      const pct=s&&sample.length>=3?Math.round(100*(sample.filter(v=>v<s.latest[unit]).length+.5*sample.filter(v=>v===s.latest[unit]).length)/sample.length)+'% (n='+sample.length+')':'Unavailable (insufficient history)';
      $('caption-september').textContent=(s?'Latest matched settlement '+s.last+'; '+s.count+' matched days since '+s.first+'. Same-week percentile: '+pct+'. ':'')+'Weekly means; '+hist.length+' completed reference seasons. '+(hist.length<3?'Historical MATIF September data not loaded; no historical band. ':'')+(change?'Change mode requires an observation in the first two weeks of September.':'');
    }
    for(const s of data.series){const l=document.createElement('label'), c=document.createElement('input');c.type='checkbox';c.checked=selected.has(s.year);c.onchange=()=>{c.checked?selected.add(s.year):selected.delete(s.year);render();};l.append(c,document.createTextNode(' '+s.year+' '));picker.append(l);}
    for(const id of ['unit','mode','history'])$(id).addEventListener('change',render);
    render();
  }catch(e){root.textContent=e.message;}
})();
