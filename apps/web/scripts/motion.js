(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add(reduceMotion ? 'pm-reduced-motion' : 'pm-motion-ready');
  if (reduceMotion) return;

  const revealSelector = '.panel,.kpi-card,.game-chip,.pred-card,.leader-row,.standings-row,.otd-item,.team-panel,.stat-card,.team-header-content';

  function observeReveals() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('pm-inview');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

    document.querySelectorAll(revealSelector).forEach(el => observer.observe(el));

    const mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches?.(revealSelector)) observer.observe(node);
          node.querySelectorAll?.(revealSelector).forEach(el => observer.observe(el));
        });
      });
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function bindPointerLight() {
    document.addEventListener('pointermove', (event) => {
      const card = event.target.closest?.('.panel,.kpi-card,.game-chip,.pred-card,.team-panel,.stat-card,.team-header-content');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--pmx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--pmy', `${event.clientY - rect.top}px`);
      card.classList.add('pm-pointer-lit');
    }, { passive: true });

    document.addEventListener('pointerout', (event) => {
      const card = event.target.closest?.('.panel,.kpi-card,.game-chip,.pred-card,.team-panel,.stat-card,.team-header-content');
      if (card) card.classList.remove('pm-pointer-lit');
    }, { passive: true });
  }

  function bindValuePulse() {
    const pulse = (node) => {
      if (!(node instanceof HTMLElement)) return;
      node.classList.remove('pm-value-pop');
      void node.offsetWidth;
      node.classList.add('pm-value-pop');
    };

    const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        const target = mutation.target;
        if (target instanceof HTMLElement && target.matches('.kpi-value,.gc-score-sm,.pred-prob-pct')) {
          pulse(target);
        }
      });
    });

    document.querySelectorAll('.kpi-value,.gc-score-sm,.pred-prob-pct').forEach(el => {
      observer.observe(el, { childList: true, characterData: true, subtree: true });
    });

    const bodyObserver = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          node.querySelectorAll?.('.kpi-value,.gc-score-sm,.pred-prob-pct').forEach(el => {
            observer.observe(el, { childList: true, characterData: true, subtree: true });
          });
        });
      });
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    observeReveals();
    bindPointerLight();
    bindValuePulse();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

