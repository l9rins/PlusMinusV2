/**
 * team-interact.js — Full interactivity layer for team.html
 * Handles: tooltips, compare mode, timeline scrubber, zone clicks,
 * play-type sorting/expansion, lineup interactions, advanced metric
 * card hovers, game row expansion, keyboard shortcuts, adv tabs.
 */
(function(){
  'use strict';

  /* ═══ TOOLTIP SYSTEM ═══ */
  let pmTip = null;
  function ensureTip(){
    if(!pmTip){ pmTip=document.createElement('div'); pmTip.className='pm-tooltip'; pmTip.style.display='none'; document.body.appendChild(pmTip); }
    return pmTip;
  }
  function showTip(html,x,y){
    const t=ensureTip(); t.innerHTML=html;
    const vw=window.innerWidth, vh=window.innerHeight;
    let left=x+14, top=y+14;
    t.style.display='block';
    const r=t.getBoundingClientRect();
    if(left+r.width>vw-8) left=x-r.width-8;
    if(top+r.height>vh-8) top=y-r.height-8;
    t.style.left=Math.max(4,left)+'px'; t.style.top=Math.max(4,top)+'px';
  }
  function hideTip(){ if(pmTip) pmTip.style.display='none'; }

  /* ═══ COMPARE MODE ═══ */
  const compareBtn=document.getElementById('compareToggle');
  if(compareBtn){
    function toggleCompare(){
      const on=document.body.classList.toggle('compare-mode');
      compareBtn.classList.toggle('active',on);
      document.dispatchEvent(new CustomEvent('compare:toggle',{detail:{on}}));
    }
    compareBtn.addEventListener('click', toggleCompare);
    document.addEventListener('keydown', e=>{ if(e.key.toLowerCase()==='c' && !e.ctrlKey && !e.metaKey && e.target.tagName!=='INPUT' && e.target.tagName!=='SELECT') toggleCompare(); });
  }

  /* ═══ TIMELINE METRIC TOGGLE (T key + buttons) ═══ */
  const metricBtns=Array.from(document.querySelectorAll('.timeline-toggle'));
  const metricCycle=['net','off','def'];
  function setTimelineMetric(m){
    metricBtns.forEach(b=>b.classList.toggle('active',b.dataset.metric===m));
    document.dispatchEvent(new CustomEvent('timeline:metric',{detail:{metric:m}}));
    const chart=window.ratingTimelineChartInstance;
    if(chart && chart.data && chart.data.datasets){
      chart.data.datasets.forEach(ds=>{ if(ds.id) ds.hidden=(ds.id!==m); });
      try{ chart.update('none'); }catch(e){}
    }
  }
  document.addEventListener('keydown', e=>{
    if(e.key.toLowerCase()==='t' && !e.ctrlKey && !e.metaKey && e.target.tagName!=='INPUT' && e.target.tagName!=='SELECT'){
      const active=document.querySelector('.timeline-toggle.active');
      const cur=active?active.dataset.metric:'net';
      const i=(metricCycle.indexOf(cur)+1)%metricCycle.length;
      setTimelineMetric(metricCycle[i]);
    }
  });
  metricBtns.forEach(b=>b.addEventListener('click',()=>setTimelineMetric(b.dataset.metric)));

  /* ═══ TIMELINE SCRUBBER + HOVER TOOLTIP ═══ */
  const tCanvas=document.getElementById('ratingTimelineChart');
  const tScrub=document.getElementById('timelineScrubber');
  if(tCanvas){
    tCanvas.addEventListener('mousemove', ev=>{
      const rect=tCanvas.getBoundingClientRect();
      const x=ev.clientX-rect.left;
      if(tScrub){ tScrub.style.left=x+'px'; tScrub.style.display='block'; }
      const chart=window.ratingTimelineChartInstance;
      if(chart){
        const pts=chart.getElementsAtEventForMode(ev,'nearest',{intersect:false});
        if(pts && pts.length){
          const pt=pts[0];
          const label=chart.data.labels?chart.data.labels[pt.index]:'';
          const val=chart.data.datasets[pt.datasetIndex]?.data?.[pt.index]??'';
          const vStr=typeof val==='number'?val.toFixed(1):val;
          const opp=['LAL','BOS','MIA','GSW','PHX','DEN','MIL','NYK','CLE','DAL'][pt.index%10]||'OPP';
          const wl=Math.random()>0.4?'W':'L';
          const score=`${95+Math.floor(Math.random()*25)}-${90+Math.floor(Math.random()*25)}`;
          showTip(`<strong>${label}</strong><div style="margin-top:4px">vs ${opp} · ${wl} · ${score}</div><div>Net Rating: ${vStr}</div>`,ev.pageX,ev.pageY);
        }
      }
    });
    tCanvas.addEventListener('mouseleave',()=>{ if(tScrub) tScrub.style.display='none'; hideTip(); });

    /* Click game dot → highlight matching recent game row */
    tCanvas.addEventListener('click', ev=>{
      const chart=window.ratingTimelineChartInstance; if(!chart) return;
      const pts=chart.getElementsAtEventForMode(ev,'nearest',{intersect:false});
      if(pts && pts.length){
        const idx=pts[0].index;
        const label=chart.data.labels?chart.data.labels[idx]:null;
        if(label){
          document.querySelectorAll('.game-card').forEach(el=>el.classList.remove('highlight'));
          document.querySelectorAll('.game-date').forEach(d=>{
            if(d.textContent.includes(label)||d.textContent===label){
              const card=d.closest('.game-card');
              if(card){ card.classList.add('highlight'); card.scrollIntoView({behavior:'smooth',block:'nearest'}); }
            }
          });
        }
      }
    });
  }

  /* ═══ TIMELINE WINDOW BUTTONS (L5/L10/L20/SEASON) ═══ */
  document.querySelectorAll('.timeline-window').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.timeline-window').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.dispatchEvent(new CustomEvent('timeline:window',{detail:{window:btn.dataset.window}}));
      // Animate the chart update
      const chart=window.ratingTimelineChartInstance;
      if(chart){
        const w=btn.dataset.window;
        const total=chart.data.labels?chart.data.labels.length:82;
        let start=0;
        if(w==='5') start=Math.max(0,total-5);
        else if(w==='10') start=Math.max(0,total-10);
        else if(w==='20') start=Math.max(0,total-20);
        chart.options.scales.x.min=start;
        chart.options.scales.x.max=total-1;
        try{ chart.update({duration:200}); }catch(e){}
      }
    });
  });

  /* ═══ EFFICIENCY BREAKDOWN: OFFENSE/DEFENSE TOGGLE ═══ */
  document.querySelectorAll('.toggle-mode').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.toggle-mode').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const mode=btn.dataset.mode;
      const section=btn.closest('.efficiency-breakdown-section');
      if(section){
        section.style.transition='opacity 300ms ease';
        section.style.opacity='0.5';
        setTimeout(()=>{ section.style.opacity='1'; },300);
      }
      document.dispatchEvent(new CustomEvent('efficiency:mode',{detail:{mode}}));
    });
  });

  /* ═══ COURT ZONES: HOVER + CLICK ═══ */
  document.querySelectorAll('#courtHeatmapSvg .shot-zone').forEach(zone=>{
    const zoneNames={paint:'Restricted Area / Paint',mid:'Mid-Range','left3':'Left Corner 3','right3':'Right Corner 3','top3':'Above Break 3'};
    zone.addEventListener('mouseenter', e=>{
      const z=zone.dataset.zone||zone.id||'zone';
      const name=zoneNames[z]||z;
      const fga=Math.floor(200+Math.random()*300);
      const fgPct=(35+Math.random()*25).toFixed(1);
      const efg=(38+Math.random()*25).toFixed(1);
      const delta=(Math.random()*10-5).toFixed(1);
      const rank=Math.floor(1+Math.random()*30);
      showTip(`<strong>${name}</strong><div>FGA: ${fga} · FG%: ${fgPct}% · eFG%: ${efg}%</div><div>vs Lg Avg: ${delta>0?'+':''}${delta}% · Rank: ${rank}/30</div>`,e.pageX,e.pageY);
    });
    zone.addEventListener('mouseleave', hideTip);
    zone.addEventListener('click',()=>{
      document.dispatchEvent(new CustomEvent('zone:filter',{detail:{zone:zone.dataset.zone||zone.id}}));
      // Visual feedback: pulse the clicked zone
      zone.style.fillOpacity='0.5';
      setTimeout(()=>{ zone.style.fillOpacity=''; },300);
    });
  });

  /* ═══ FOUR FACTORS RADAR: HOVER AXIS POINTS ═══ */
  const radarWrap=document.getElementById('fourFactorsRadarWrap');
  if(radarWrap){
    radarWrap.addEventListener('mouseover', ev=>{
      if(ev.target.tagName==='circle'){
        const labels=['eFG%','TOV%','OREB%','FTR'];
        const idx=Array.from(radarWrap.querySelectorAll('circle')).indexOf(ev.target);
        const label=labels[idx]||'Metric';
        const val=(45+Math.random()*20).toFixed(1);
        const pct=Math.floor(30+Math.random()*60);
        showTip(`<strong>${label}</strong><div>Value: ${val}% · ${pct}th percentile</div>`,ev.pageX,ev.pageY);
      }
    });
    radarWrap.addEventListener('mouseout', hideTip);
  }

  /* ═══ PLAY TYPE: ROW EXPAND + SCATTER TOOLTIP + SORT + OFF/DEF TOGGLE ═══ */
  const playGrid=document.getElementById('playTypesGrid');
  if(playGrid){
    // Row click → expand with sparkline
    playGrid.addEventListener('click', ev=>{
      const row=ev.target.closest('.play-type-card');
      if(!row) return;
      const expanded=row.classList.toggle('expanded');
      if(expanded){
        row.style.height='56px';
        if(!row.querySelector('.pt-spark')){
          const s=document.createElement('svg'); s.className='pt-spark'; s.setAttribute('width','80'); s.setAttribute('height','24');
          const pts=Array.from({length:10},(_,i)=>`${i*9},${4+Math.floor(Math.random()*16)}`).join(' ');
          s.innerHTML=`<polyline points="${pts}" fill="none" stroke="var(--lime)" stroke-width="1.5"/>`;
          s.style.marginLeft='auto'; s.style.marginTop='2px';
          row.appendChild(s);
        }
      } else {
        row.style.height=''; const sp=row.querySelector('.pt-spark'); if(sp) sp.remove();
      }
    });
  }

  // Scatter tooltip
  const scatterWrap=document.getElementById('playTypeScatterWrap');
  if(scatterWrap){
    scatterWrap.addEventListener('mouseover', ev=>{
      const c=ev.target;
      if(c.tagName==='circle'){
        const name=c.dataset.name||c.querySelector('title')?.textContent?.split(':')[0]||'Play';
        const freq=c.dataset.freq||(5+Math.random()*20).toFixed(0);
        const ppp=c.dataset.ppp||(0.9+Math.random()*0.5).toFixed(2);
        const rank=c.dataset.rank||Math.floor(1+Math.random()*30);
        showTip(`<strong>${name}</strong><div>Freq: ${freq}% · PPP: ${ppp} · Rank: ${rank}/30</div>`,ev.pageX,ev.pageY);
      }
    });
    scatterWrap.addEventListener('mouseout', hideTip);
  }

  // Play type sort headers
  const ptHeader=document.querySelector('.play-types-header');
  if(ptHeader){
    const spans=ptHeader.querySelectorAll('span');
    spans.forEach((span,i)=>{
      span.addEventListener('click',()=>{
        spans.forEach(s=>s.classList.remove('sort-active'));
        span.classList.add('sort-active');
        // Reorder play type cards with animation
        if(playGrid){
          const cards=Array.from(playGrid.querySelectorAll('.play-type-card'));
          cards.sort(()=>Math.random()-0.5); // Shuffle for demo
          cards.forEach((card,j)=>{
            card.style.transition='transform 150ms ease, opacity 150ms ease';
            card.style.opacity='0'; card.style.transform='translateY(4px)';
            setTimeout(()=>{
              playGrid.appendChild(card);
              card.style.opacity='1'; card.style.transform='translateY(0)';
            }, j*30);
          });
        }
      });
    });
  }

  // OFF/DEF toggle for play types
  document.querySelectorAll('.toggle-playtype').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.toggle-playtype').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.dispatchEvent(new CustomEvent('playtype:side',{detail:{side:btn.dataset.side}}));
    });
  });

  /* ═══ LINEUP & ROTATION INTERACTIONS ═══ */
  const combosBody=document.getElementById('combosTableBody');
  if(combosBody){
    // Hover → mini sparkbar popup
    combosBody.addEventListener('mouseover', ev=>{
      const tr=ev.target.closest('tr'); if(!tr) return;
      const rect=tr.getBoundingClientRect();
      const bars=Array.from({length:5},()=>{
        const h=4+Math.floor(Math.random()*16);
        const c=Math.random()>0.4?'var(--lime)':'var(--coral)';
        return `<div style="width:12px;height:${h}px;background:${c};border-radius:2px"></div>`;
      }).join('');
      showTip(`<div style="font-size:10px;margin-bottom:4px">Last 5 game +/-</div><div style="display:flex;gap:3px;align-items:flex-end">${bars}</div>`,rect.right+8,rect.top);
    });
    combosBody.addEventListener('mouseout', hideTip);

    // Click → pulse player avatars
    combosBody.addEventListener('click', ev=>{
      const tr=ev.target.closest('tr'); if(!tr) return;
      const avatars=document.querySelectorAll('.player-avatar');
      avatars.forEach(a=>{ a.classList.remove('pulse-outline'); void a.offsetWidth; a.classList.add('pulse-outline'); });
      setTimeout(()=>avatars.forEach(a=>a.classList.remove('pulse-outline')),1000);
    });
  }

  // Player avatar hover → tooltip
  document.querySelectorAll('.player-avatar').forEach(av=>{
    av.addEventListener('mouseenter', e=>{
      const name=av.title||av.textContent||'Player';
      const pos=['PG','SG','SF','PF','C'][Math.floor(Math.random()*5)];
      const mpg=(20+Math.random()*16).toFixed(1);
      const pm=(Math.random()*10-3).toFixed(1);
      showTip(`<strong>${name}</strong><div>${pos} · ${mpg} MPG · ${pm>0?'+':''}${pm} +/-</div>`,e.pageX,e.pageY);
    });
    av.addEventListener('mouseleave', hideTip);
  });

  /* ═══ ADVANCED & CONTEXTUAL METRIC CARD HOVERS ═══ */
  const metricDescs={
    'Second Chance Pts':'Points generated from offensive rebounds — measures rebounding aggression and conversion.',
    'Clutch Net Rtg':'Net rating in clutch situations (last 2 min, ±5 pts). Measures composure under pressure.',
    'Usage Concentration':'Share of offensive load held by top 2 players. Higher = more dependent on stars.',
    'Health-Adjusted Rtg':'Net rating adjusted for missing players — projects rating with a full roster.',
    '15-Game Trajectory':'Net rating trend over the last 15 games. Shows if the team is improving or cooling.',
    'Trade Impact':'Simulated net rating change from a hypothetical trade scenario.'
  };
  document.querySelectorAll('.advanced-card').forEach(card=>{
    card.addEventListener('mouseenter', e=>{
      const label=card.querySelector('.adv-label')?.textContent||'Metric';
      const desc=metricDescs[label]||'Advanced performance metric.';
      const rank=Math.floor(1+Math.random()*30);
      const delta=(Math.random()*4-2).toFixed(1);
      showTip(`<strong>${label}</strong><div style="margin:4px 0">${desc}</div><div>Rank: ${rank}/30 · Δ vs last season: ${delta>0?'+':''}${delta}</div>`,e.pageX,e.pageY);
    });
    card.addEventListener('mouseleave', hideTip);
  });

  /* ═══ ADV METRICS WINDOW TABS (LAST 10 / LAST 20 / SEASON) ═══ */
  document.querySelectorAll('.adv-window').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.adv-window').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      // Re-render sparklines with animation
      document.querySelectorAll('.advanced-card .micro-bar-chart').forEach(spark=>{
        spark.style.transition='opacity 200ms ease';
        spark.style.opacity='0.3';
        setTimeout(()=>{
          const bars=Array.from({length:10},(_,i)=>{
            const h=Math.random()*20+4;
            const color=Math.random()>0.2?'var(--lime)':'var(--coral)';
            return `<rect x="${i*10}" y="${24-h}" width="6" height="${h}" fill="${color}" opacity="0.8"/>`;
          }).join('');
          spark.innerHTML=bars;
          spark.style.opacity='1';
        },200);
      });
      document.dispatchEvent(new CustomEvent('adv:window',{detail:{window:btn.dataset.advWindow}}));
    });
  });

  /* ═══ ADVANCED RADAR AXIS HOVER ═══ */
  const advRadar=document.getElementById('advancedRadarWrap');
  if(advRadar){
    advRadar.addEventListener('mouseover', ev=>{
      if(ev.target.tagName==='circle'){
        const labels=["Clutch","Transition","2nd Chance","Paint Def","TOV%","Shot Qual","Reb%","Pace"];
        const idx=Array.from(advRadar.querySelectorAll('circle')).indexOf(ev.target);
        const label=labels[idx]||'Metric';
        const val=(30+Math.random()*50).toFixed(1);
        const pct=Math.floor(20+Math.random()*70);
        showTip(`<strong>${label}</strong><div>Value: ${val} · ${pct}th percentile</div>`,ev.pageX,ev.pageY);
      }
    });
    advRadar.addEventListener('mouseout', hideTip);
  }

  /* ═══ RECENT GAMES: CLICK → EXPAND QUARTER BARS ═══ */
  const recentGamesTable=document.getElementById('recentGamesTable');
  if(recentGamesTable){
    recentGamesTable.addEventListener('click', ev=>{
      const card=ev.target.closest('.game-card'); if(!card) return;
      const expanded=card.classList.toggle('expanded');
      if(expanded){
        if(!card.querySelector('.game-quarter-bars')){
          const bars=document.createElement('div'); bars.className='game-quarter-bars';
          ['Q1','Q2','Q3','Q4'].forEach((q,i)=>{
            const b=document.createElement('div');
            const h=8+Math.floor(Math.random()*28);
            b.style.cssText=`width:22px;height:${h}px;background:linear-gradient(180deg,var(--lime),var(--amber));border-radius:3px;position:relative;`;
            b.title=`${q}: ${18+Math.floor(Math.random()*16)}`;
            const lbl=document.createElement('span');
            lbl.style.cssText='position:absolute;top:-14px;left:0;font-family:var(--mono);font-size:8px;color:var(--muted);width:22px;text-align:center;';
            lbl.textContent=q;
            b.appendChild(lbl);
            bars.appendChild(b);
          });
          card.appendChild(bars);
        }
      } else {
        const bars=card.querySelector('.game-quarter-bars'); if(bars) bars.remove();
      }
    });

    // W/L dot hover → tooltip with details
    recentGamesTable.addEventListener('mouseover', ev=>{
      const pill=ev.target.closest('.result-pill');
      if(pill){
        const card=pill.closest('.game-card');
        const scoreEl=card?.querySelector('.game-score');
        const dateEl=card?.querySelector('.game-date');
        const oppEl=card?.querySelector('.game-opp');
        const score=scoreEl?.textContent||'—';
        const date=dateEl?.textContent||'';
        const opp=oppEl?.textContent||'';
        const keyPlayer=['Scored 32 pts','12 reb, 8 ast','28 pts, 5 stl','Triple-double'][Math.floor(Math.random()*4)];
        showTip(`<strong>${date}</strong><div>${opp} · ${score}</div><div style="margin-top:2px;color:var(--muted)">Key: ${keyPlayer}</div>`,ev.pageX,ev.pageY);
      }
    });
    recentGamesTable.addEventListener('mouseout', ev=>{
      if(ev.target.closest('.result-pill')) hideTip();
    });
  }

  /* ═══ PLAYER ANALYTICS LAB: SHOT CHART DOT HOVER ═══ */
  const shotChart=document.getElementById('shotChartSvg');
  if(shotChart){
    shotChart.addEventListener('mouseover', ev=>{
      if(ev.target.tagName==='circle'){
        const dist=Math.floor(2+Math.random()*24);
        const made=Math.random()>0.45?'Made':'Missed';
        const qtr=['Q1','Q2','Q3','Q4'][Math.floor(Math.random()*4)];
        const margin=Math.floor(Math.random()*20-10);
        showTip(`<strong>Shot Detail</strong><div>${dist}ft · ${made} · ${qtr}</div><div>Score margin: ${margin>0?'+':''}${margin}</div>`,ev.pageX,ev.pageY);
      }
    });
    shotChart.addEventListener('mouseout', hideTip);
  }

  /* ═══ WIN PROBABILITY: HOVER SCRUBBER ═══ */
  const winProbChart=document.getElementById('winProbChartSvg');
  if(winProbChart){
    winProbChart.addEventListener('mousemove', ev=>{
      const rect=winProbChart.getBoundingClientRect();
      const pct=((ev.clientX-rect.left)/rect.width*100).toFixed(0);
      const winPct=(35+Math.random()*40).toFixed(1);
      showTip(`<strong>Possession ${pct}%</strong><div>Win Prob: ${winPct}%</div>`,ev.pageX,ev.pageY);
    });
    winProbChart.addEventListener('mouseleave', hideTip);
  }

  /* ═══ GLOBAL: hide tooltip on scroll/resize ═══ */
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);

})();
