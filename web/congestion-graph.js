// Turn cumulative receiver counters into packet rates, using sample timestamps.
export class CongestionHistory {
  constructor() {
    this.sessionId = null;
    this.previous = null;
    this.points = [];
    this.active = false;
  }

  get lines() {
    return Object.fromEntries(['marked', 'unmarked'].map(key => [
      key, this.points.map(point => ({ time: point.time, value: point[key] })),
    ]));
  }

  get time() { return this.previous?.clientTimeMs; }

  update(sample) {
    if (!sample) return false;
    if (sample.sessionId !== this.sessionId) {
      this.sessionId = sample.sessionId;
      this.previous = null;
      this.points = [];
    }
    this.active = sample.active;
    const counters = ['clientTimeMs', 'ceMarkedPackets', 'notCeMarkedPackets'];
    if (!counters.every(key => Number.isFinite(sample[key]))) return false;
    if (this.previous && sample.clientTimeMs <= this.previous.clientTimeMs) return false;

    if (this.previous) {
      const seconds = (sample.clientTimeMs - this.previous.clientTimeMs) / 1000;
      const marked = sample.ceMarkedPackets - this.previous.ceMarkedPackets;
      const unmarked = sample.notCeMarkedPackets - this.previous.notCeMarkedPackets;
      if (marked >= 0 && unmarked >= 0) {
        this.points.push({ time: sample.clientTimeMs, marked: marked / seconds, unmarked: unmarked / seconds });
        this.points = this.points.filter(point => point.time >= sample.clientTimeMs - 60000);
      } else {
        // A counter reset is a new baseline, not a negative packet rate.
        this.points = [];
      }
    }
    this.previous = sample;
    return true;
  }
}

// Sender and receiver sample independently; preserve each line's own timestamps.
export class BitrateHistory {
  constructor() {
    this.lines = { sent: [], received: [] };
    this.latest = {};
  }

  get time() { return Math.max(0, ...Object.values(this.latest).map(sample => sample.clientTimeMs)); }
  get active() { return Object.values(this.latest).some(sample => sample.active); }

  update({ sender, receiver }) {
    let changed = false;
    for (const [key, sample, field] of [
      ['sent', sender, 'sentBytesPerSecond'],
      ['received', receiver, 'receivedBytesPerSecond'],
    ]) {
      if (!sample || !Number.isFinite(sample.clientTimeMs) || !Number.isFinite(sample[field])) continue;
      const previous = this.latest[key];
      if (!previous || previous.sessionId !== sample.sessionId) this.lines[key] = [];
      else if (sample.clientTimeMs <= previous.clientTimeMs) continue;
      this.lines[key].push({ time: sample.clientTimeMs, value: Math.max(0, sample[field]) * 8 / 1_000_000 });
      this.latest[key] = sample;
      changed = true;
    }
    for (const key of Object.keys(this.lines)) {
      this.lines[key] = this.lines[key].filter(point => point.time >= this.time - 60000);
    }
    return changed;
  }
}

// Shared renderer for rate graphs, with a rolling time axis and hover readout.
class TimeSeriesGraph {
  constructor(root, { history, series, title, unit, minimum, step, hint }) {
    this.root = root;
    this.history = history;
    this.series = series;
    this.unit = unit;
    this.minimum = minimum;
    this.step = step;
    root.classList.add('congestion-chart');
    root.innerHTML = `
      <div class="chart-heading"><h3>${title}</h3><span data-chart-state></span></div>
      <div class="chart-legend">${series.map(line => `
        <span style="color:${line.color}">${line.label} <strong data-rate="${line.key}">—</strong></span>
      `).join('')}</div>
      <div class="chart-plot">
        <svg viewBox="0 0 1000 235" role="img" aria-label="${title}, last 60 seconds">
          <g class="chart-grid"><path d="M60 25H980 M60 112.5H980 M60 200H980"/></g>
          <g class="chart-labels">
            <text x="48" y="29" text-anchor="end" data-y-max></text>
            <text x="48" y="117" text-anchor="end" data-y-mid></text>
            <text x="48" y="204" text-anchor="end">0</text>
            <text x="60" y="226">−60 s</text><text x="520" y="226" text-anchor="middle">−30 s</text>
            <text x="980" y="226" text-anchor="end">Latest</text>
          </g>
          ${series.map(line => `<path class="chart-line" data-line="${line.key}" stroke="${line.color}"/>`).join('')}
          <line class="chart-cursor" data-cursor y1="25" y2="200" style="display:none"/>
        </svg>
        <p class="chart-empty" data-empty>Start video to see the graph.</p>
        <p class="chart-tooltip" data-tooltip hidden></p>
      </div>
      <p class="hint">${hint}</p>`;
    this.svg = root.querySelector('svg');
    this.cursor = root.querySelector('[data-cursor]');
    this.tooltip = root.querySelector('[data-tooltip]');
    this.svg.addEventListener('pointermove', event => this.hover(event));
    this.svg.addEventListener('pointerleave', () => this.hideHover());
    this.render();
  }

  update(sample) {
    if (this.history.update(sample)) this.render();
  }

  format(value) { return `${value.toFixed(this.unit === 'Mbps' ? 3 : 1)} ${this.unit}`; }
  x(time) { return 60 + (time - (this.endTime - 60000)) / 60000 * 920; }
  y(value) { return 200 - value / this.yMaximum * 175; }

  render() {
    this.hideHover();
    const lines = this.history.lines;
    this.endTime = this.history.time || Date.now();
    const maximum = Math.max(0, ...Object.values(lines).flat().map(point => point.value));
    this.yMaximum = Math.max(this.minimum, Math.ceil(maximum / this.step) * this.step);
    this.root.querySelector('[data-y-max]').textContent = Number(this.yMaximum.toFixed(3));
    this.root.querySelector('[data-y-mid]').textContent = Number((this.yMaximum / 2).toFixed(3));
    for (const { key } of this.series) {
      const points = lines[key];
      const path = points.map((point, index) => {
        const gap = index === 0 || point.time - points[index - 1].time > 3500;
        return `${gap ? 'M' : 'L'}${this.x(point.time).toFixed(1)},${this.y(point.value).toFixed(1)}`;
      }).join(' ');
      this.root.querySelector(`[data-line="${key}"]`).setAttribute('d', path);
      this.root.querySelector(`[data-rate="${key}"]`).textContent = points.length
        ? this.format(points.at(-1).value) : '—';
    }
    this.root.querySelector('[data-empty]').hidden = Object.values(lines).some(points => points.length > 0);
    this.root.querySelector('[data-chart-state]').textContent = !this.history.time
      ? 'Waiting for video' : this.history.active ? 'Live · last 60 seconds' : 'Stopped · last 60 seconds';
  }

  hover(event) {
    const bounds = this.svg.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * 1000;
    const selected = this.series.map(line => {
      const points = this.history.lines[line.key];
      if (!points.length) return null;
      const point = points.reduce((best, point) => (
        Math.abs(this.x(point.time) - x) < Math.abs(this.x(best.time) - x) ? point : best
      ));
      return { ...line, ...point };
    }).filter(Boolean);
    if (!selected.length) return;
    const position = this.x(selected[0].time);
    this.cursor.setAttribute('x1', position);
    this.cursor.setAttribute('x2', position);
    this.cursor.style.display = '';
    this.tooltip.hidden = false;
    this.tooltip.textContent = selected.map(point => (
      `${point.label}: ${this.format(point.value)} (${((this.endTime - point.time) / 1000).toFixed(1)}s ago)`
    )).join(' · ');
  }

  hideHover() {
    this.cursor.style.display = 'none';
    this.tooltip.hidden = true;
  }
}

export class CongestionGraph extends TimeSeriesGraph {
  constructor(root) {
    super(root, {
      history: new CongestionHistory(), title: 'Received video packets / second',
      unit: 'packets/s', minimum: 10, step: 25,
      series: [
        { key: 'marked', label: 'Congestion-marked', color: '#ffb36b' },
        { key: 'unmarked', label: 'Unmarked', color: '#78c8ff' },
      ],
      hint: 'Received packets with a congestion mark versus those without one. Hover to inspect; a new call resets the graph.',
    });
  }
}

export class BitrateGraph extends TimeSeriesGraph {
  constructor(root) {
    super(root, {
      history: new BitrateHistory(), title: 'Live video bitrate · Mbps',
      unit: 'Mbps', minimum: 1.2, step: 0.2,
      series: [
        { key: 'sent', label: 'Sent', color: '#9ce5b8' },
        { key: 'received', label: 'Received', color: '#b8a5ff' },
      ],
      hint: 'Video payload bitrate, excluding protocol overhead. Hover to inspect; a new call resets each line.',
    });
  }
}
