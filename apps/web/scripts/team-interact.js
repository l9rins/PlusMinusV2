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
    if(!pmTip){
      pmTip=document.createElement('div');
      pmTip.className='pm-tooltip';
      // Inline styles to guarantee a floaty glassmorphic premium look
      pmTip.style.position='absolute';
      pmTip.style.zIndex='10000';
      pmTip.style.pointerEvents='none';
      pmTip.style.background='rgba(12, 12, 20, 0.9)';
      pmTip.style.backdropFilter='blur(12px)';
      pmTip.style.webkitBackdropFilter='blur(12px)';
      pmTip.style.border='1px solid rgba(255, 255, 255, 0.12)';
      pmTip.style.borderRadius='4px';
      pmTip.style.padding='8px 10px';
      pmTip.style.boxShadow='0 4px 16px rgba(0, 0, 0, 0.5)';
      pmTip.style.color='var(--text)';
      pmTip.style.fontSize='11px';
      pmTip.style.lineHeight='1.45';
      pmTip.style.display='none';
      document.body.appendChild(pmTip);
    }
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
          let opp = 'OPP', wl = '-', score = '0-0';
          if (window._TIMELINE_GAMES && window._TIMELINE_GAMES[pt.index]) {
            const game = window._TIMELINE_GAMES[pt.index];
            const isHome = game.home === window.TEAM_ABBR;
            opp = isHome ? game.away : game.home;
            const ourScore = isHome ? game.homeScore : game.awayScore;
            const oppScore = isHome ? game.awayScore : game.homeScore;
            if (ourScore && oppScore) {
              wl = Number(ourScore) > Number(oppScore) ? 'W' : 'L';
              score = `${ourScore}-${oppScore}`;
            }
          }
          showTip(`<strong>${label}</strong><div style="margin-top:4px">vs ${opp} · ${wl} · ${score}</div><div>Rating: ${vStr}</div>`,ev.pageX,ev.pageY);
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
        const s=document.createElement('svg'); s.className='pt-spark'; s.setAttribute('width','80'); s.setAttribute('height','24');
        // Use real data attribute if available, else static
        const sparkData = row.dataset.spark || "0,15 9,12 18,10 27,18 36,14 45,8 54,6 63,10 72,4 81,12";
        s.innerHTML=`<polyline points="${sparkData}" fill="none" stroke="var(--lime)" stroke-width="1.5"/>`;
        s.style.marginLeft='auto'; s.style.marginTop='2px';
        row.appendChild(s);
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
        const freq=c.dataset.freq||'0';
        const ppp=c.dataset.ppp||'0.00';
        const rank=c.dataset.rank||'-';
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
          cards.sort((a,b) => {
            const freqA = parseFloat(a.querySelector('.pt-bar-label')?.textContent) || 0;
            const freqB = parseFloat(b.querySelector('.pt-bar-label')?.textContent) || 0;
            return freqB - freqA;
          });
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
      const tr=av.closest('tr');
      const pos=tr.dataset.pos||'Mix';
      const mpg=tr.dataset.mpg||'0.0';
      const pm=tr.dataset.pm||'0.0';
      showTip(`<strong>${name}</strong><div>Pos: ${pos} · Min/g: ${mpg}</div><div>Net: ${pm>0?'+':''}${pm}</div>`,e.pageX,e.pageY);
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
      const rank=card.dataset.rank||'-';
      const delta=card.dataset.delta||'0.0';
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
          const bars=spark.dataset.vals?.split(',').map((h,i)=>{
            const color=parseInt(h)>15?'var(--lime)':'var(--coral)';
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
        const val=ev.target.dataset.val||'0.0';
        const pct=ev.target.dataset.pct||'0';
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
          const qData=card.dataset.quarters?.split(',')||['10','10','10','10'];
          ['Q1','Q2','Q3','Q4'].forEach((q,i)=>{
            const b=document.createElement('div');
            const h=parseInt(qData[i]);
            b.style.cssText=`width:22px;height:${h}px;background:linear-gradient(180deg,var(--lime),var(--amber));border-radius:3px;position:relative;`;
            b.title=`${q}: ${h}`;
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
        const score=card?.dataset.score||'—';
        const date=card?.dataset.date||'';
        const opp=card?.dataset.opp||'';
        const keyPlayer=card?.dataset.key||'';
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
      const c=ev.target;
      if(c.tagName==='circle'){
        const isMake=c.getAttribute('fill')==='var(--lime)'||c.getAttribute('opacity')==='1';
        const dist=c.dataset.dist||'15';
        const made=isMake?'Made':'Missed';
        const qtr=c.dataset.qtr||'Q2';
        const margin=c.dataset.margin||'+2';
        showTip(`<div>${dist}ft Jumper - <strong>${made}</strong></div><div style="margin-top:4px;font-size:11px;color:var(--muted)">${qtr} · Margin: ${margin}</div>`,ev.pageX,ev.pageY);
      }
    });
    shotChart.addEventListener('mouseout', hideTip);
  }

  /* ═══ WIN PROBABILITY: HOVER SCRUBBER ═══ */
  const winProbChart=document.getElementById('winProbChartSvg');
  if(winProbChart){
    winProbChart.addEventListener('mousemove', ev=>{
      try {
        const pointsStr = winProbChart.dataset.points;
        if (!pointsStr) return;
        const points = JSON.parse(pointsStr);
        if (!Array.isArray(points) || !points.length) return;

        const rect = winProbChart.getBoundingClientRect();
        const xFraction = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        // The SVG chart extends from x=24 to x=352 (width 328)
        const svgX = 24 + xFraction * 328;

        // Find closest point by x coordinate
        let closest = points[0];
        let minDist = Math.abs(points[0].x - svgX);
        let closestIndex = 0;
        for (let i = 1; i < points.length; i++) {
          const d = Math.abs(points[i].x - svgX);
          if (d < minDist) {
            minDist = d;
            closest = points[i];
            closestIndex = i;
          }
        }

        // Dynamically position tracking elements inside the SVG
        const group = document.getElementById('winProbScrubberGroup');
        const vLine = document.getElementById('winProbVerticalLine');
        const hLine = document.getElementById('winProbHorizontalLine');
        const glowCircle = document.getElementById('winProbTrackGlow');
        const trackCircle = document.getElementById('winProbTrackCircle');
        const yBadge = document.getElementById('winProbYBadgeGroup');
        const yBadgeText = document.getElementById('winProbYBadgeText');
        const xBadge = document.getElementById('winProbXBadgeGroup');
        const xBadgeText = document.getElementById('winProbXBadgeText');

        if (group && vLine && glowCircle && trackCircle) {
          group.setAttribute('opacity', '1');
          vLine.setAttribute('x1', closest.x.toFixed(1));
          vLine.setAttribute('x2', closest.x.toFixed(1));
          if (hLine) {
            hLine.setAttribute('y1', closest.y.toFixed(1));
            hLine.setAttribute('y2', closest.y.toFixed(1));
          }
          if (yBadge) {
            yBadge.setAttribute('transform', `translate(1, ${closest.y.toFixed(1)})`);
          }
          if (yBadgeText) {
            yBadgeText.textContent = `${Math.round(closest.p)}%`;
          }
          if (xBadge) {
            xBadge.setAttribute('transform', `translate(${closest.x.toFixed(1)}, 310)`);
          }
          if (xBadgeText) {
            xBadgeText.textContent = `Poss. ${closestIndex + 1}`;
          }
          glowCircle.setAttribute('cx', closest.x.toFixed(1));
          glowCircle.setAttribute('cy', closest.y.toFixed(1));
          trackCircle.setAttribute('cx', closest.x.toFixed(1));
          trackCircle.setAttribute('cy', closest.y.toFixed(1));
        }

        // Gather team names from dataset
        const home = winProbChart.dataset.homeTeam || 'HOME';
        const away = winProbChart.dataset.awayTeam || 'AWY';

        const color = closest.p > 50 ? 'var(--lime)' : 'var(--blue)';
        const leadTeam = closest.p > 50 ? home : away;
        const leadPct = closest.p > 50 ? Math.round(closest.p) : Math.round(100 - closest.p);

        // Render breathtaking glassmorphic live momentum HUD tooltip
        const html = `
          <div style="font-family:var(--mono);font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Momentum Tracker</div>
          <div style="font-size:11px;font-weight:800;margin-bottom:6px;display:flex;align-items:center;gap:6px;color:var(--text)">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color};"></span>
            Possession ${closestIndex + 1}
          </div>
          <div style="font-size:11px;color:var(--text2);line-height:1.45;">
            <strong style="color:${color};font-family:var(--mono);font-weight:700">${leadTeam}</strong> possesses a <strong style="color:var(--text);font-weight:800">${leadPct}%</strong> win probability
          </div>
          <div style="margin-top:6px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.06);font-size:8px;color:var(--muted2);font-family:var(--mono);letter-spacing:0.4px;">
            Baseline Differential: ${Math.abs(Math.round(closest.p - 50))}% vs parity
          </div>
        `;

        showTip(html, ev.pageX, ev.pageY);
      } catch (err) {
        console.warn('[PM] Scrubber scrubbing error:', err);
      }
    });

    winProbChart.addEventListener('mouseleave', () => {
      const group = document.getElementById('winProbScrubberGroup');
      if (group) group.setAttribute('opacity', '0');
      hideTip();
    });
  }

  const radarChart=document.getElementById('radarChartSvg');
  if(radarChart){
    radarChart.addEventListener('mousemove', ev => {
      const node = ev.target.closest('.radar-node');
      if (node) {
        const statName = node.dataset.stat;
        const p1Val = node.dataset.p1Val;
        const p2Val = node.dataset.p2Val;
        const p1Name = node.dataset.p1Name;
        const p2Name = node.dataset.p2Name;
        const maxVal = node.dataset.maxVal;

        const p1Percent = Math.round((parseFloat(p1Val) / parseFloat(maxVal)) * 100);
        const p2Percent = Math.round((parseFloat(p2Val) / parseFloat(maxVal)) * 100);

        const html = `
          <div style="font-family:var(--mono);font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:1.0px;margin-bottom:4px;">Comparative Radar HUD</div>
          <div style="font-size:11px;font-weight:800;color:var(--text);margin-bottom:6px;display:flex;align-items:center;gap:6px;">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--lime);box-shadow:0 0 8px var(--lime);"></span>
            ${statName} Metric
          </div>
          <div style="font-size:11px;color:var(--text2);line-height:1.45;margin-bottom:4px;">
            <span style="color:var(--lime);font-family:var(--mono);font-weight:700">${p1Name}</span>: 
            <strong style="color:var(--text);font-weight:800">${p1Val}</strong> <span style="font-size:9px;color:var(--muted)">(${p1Percent}% scale)</span>
          </div>
          <div style="font-size:11px;color:var(--text2);line-height:1.45;padding-top:4px;border-top:1px solid rgba(255,255,255,0.06);">
            <span style="color:var(--blue);font-family:var(--mono);font-weight:700">${p2Name}</span>: 
            <strong style="color:var(--text);font-weight:800">${p2Val}</strong> <span style="font-size:9px;color:var(--muted)">(${p2Percent}% scale)</span>
          </div>
        `;
        showTip(html, ev.pageX, ev.pageY);
      } else {
        hideTip();
      }
    });

    radarChart.addEventListener('mouseleave', hideTip);
  }

  /* ═══ GLOBAL: hide tooltip on scroll/resize ═══ */
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);

})();
