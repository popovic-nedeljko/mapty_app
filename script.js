'use strict';

// Open-Meteo weather code → emoji
const WEATHER_ICONS = {
  0: '☀️', 1: '🌤', 2: '⛅', 3: '☁️',
  45: '🌫', 48: '🌫',
  51: '🌦', 53: '🌦', 55: '🌧',
  61: '🌧', 63: '🌧', 65: '🌧',
  71: '🌨', 73: '🌨', 75: '❄️',
  80: '🌦', 81: '🌧', 82: '⛈',
  95: '⛈', 96: '⛈', 99: '⛈',
};

// ─── Data classes ─────────────────────────────────────────────────────────────

class Workout {
  date = new Date();
  id = crypto.randomUUID();
  weather = null;
  route = null; // array of [lat,lng] when a drawn route exists

  constructor(coords, distance, duration) {
    this.coords = coords; // [lat, lng] — start point or pin
    this.distance = distance; // km
    this.duration = duration; // min
  }

  _setDescription() {
    // prettier-ignore
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    this.description = `${this.type[0].toUpperCase()}${this.type.slice(1)} on ${
      months[this.date.getMonth()]
    } ${this.date.getDate()}`;
  }
}

class Running extends Workout {
  type = 'running';

  constructor(coords, distance, duration, cadence) {
    super(coords, distance, duration);
    this.cadence = cadence;
    this.calcPace();
    this._setDescription();
  }

  calcPace() {
    this.pace = this.duration / this.distance; // min/km
    return this.pace;
  }
}

class Cycling extends Workout {
  type = 'cycling';

  constructor(coords, distance, duration, elevationGain) {
    super(coords, distance, duration);
    this.elevationGain = elevationGain;
    this.calcSpeed();
    this._setDescription();
  }

  calcSpeed() {
    this.speed = this.distance / (this.duration / 60); // km/h
    return this.speed;
  }
}

// ─── App ──────────────────────────────────────────────────────────────────────

class App {
  #map;
  #mapZoomLevel = 13;
  #mapEvent;
  #workouts = [];
  #markers = new Map();       // workoutId → L.marker
  #routePolylines = new Map(); // workoutId → L.polyline

  #editingId = null;
  #currentFilter = 'all';
  #currentSort = 'date';
  #chartPeriod = 'week';
  #chart = null;
  #tileLayer = null;

  // Route drawing state
  #routeMode = false;
  #routePoints = [];
  #routePreview = null;
  #routeWaypoints = []; // circleMarkers during drawing

  // DOM references
  #form = document.querySelector('.form');
  #workoutsList = document.querySelector('.workouts');
  #inputType = document.querySelector('.form__input--type');
  #inputDistance = document.querySelector('.form__input--distance');
  #inputDuration = document.querySelector('.form__input--duration');
  #inputCadence = document.querySelector('.form__input--cadence');
  #inputElevation = document.querySelector('.form__input--elevation');
  #formError = document.querySelector('.form__error');
  #emptyState = document.querySelector('.empty-state');
  #statsCanvas = document.querySelector('.stats__canvas');

  constructor() {
    this._getPosition();
    this._getLocalStorage();
    this._bindEvents();
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  _bindEvents() {
    // form
    this.#form.addEventListener('submit', this._newWorkout.bind(this));
    this.#inputType.addEventListener('change', this._toggleElevationField.bind(this));
    [this.#inputDistance, this.#inputDuration, this.#inputCadence, this.#inputElevation]
      .forEach(inp => inp.addEventListener('input', () => this._validateInput(inp)));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this._hideForm(); });

    // controls
    document.querySelector('.controls__select--filter')
      .addEventListener('change', e => { this.#currentFilter = e.target.value; this._renderWorkoutList(); this._applyMapFilter(); });
    document.querySelector('.controls__select--sort')
      .addEventListener('change', e => { this.#currentSort = e.target.value; this._renderWorkoutList(); });
    document.querySelector('.controls__btn--fit')
      .addEventListener('click', this._fitBounds.bind(this));
    document.querySelector('.controls__btn--route')
      .addEventListener('click', this._toggleRouteMode.bind(this));
    document.querySelector('.controls__btn--clear-all')
      .addEventListener('click', this._deleteAllWorkouts.bind(this));
    document.querySelector('.controls__select--theme')
      .addEventListener('change', e => this._switchTileTheme(e.target.value));

    // main tabs (Workouts / Stats)
    document.querySelectorAll('.tab').forEach(tab =>
      tab.addEventListener('click', e => {
        const target = e.currentTarget.dataset.tab;
        document.querySelectorAll('.tab').forEach(t =>
          t.classList.toggle('tab--active', t.dataset.tab === target)
        );
        document.querySelector('.tab-panel--workouts').classList.toggle('hidden', target !== 'workouts');
        document.querySelector('.tab-panel--stats').classList.toggle('hidden', target !== 'stats');
        if (target === 'stats') this._renderStats();
      })
    );

    // stats chart period tabs
    document.querySelectorAll('.stats__tab').forEach(tab =>
      tab.addEventListener('click', e => {
        document.querySelectorAll('.stats__tab').forEach(t => t.classList.remove('stats__tab--active'));
        e.target.classList.add('stats__tab--active');
        this.#chartPeriod = e.target.dataset.period;
        this._renderChart();
      })
    );

    // geolocation manual fallback
    document.querySelector('.geo-error__btn').addEventListener('click', () => {
      const lat = parseFloat(document.querySelector('.geo-error__input--lat').value);
      const lng = parseFloat(document.querySelector('.geo-error__input--lng').value);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        document.querySelector('.geo-error').classList.add('hidden');
        this._initMap([lat, lng]);
      }
    });

    // workout list clicks (delegation)
    this.#workoutsList.addEventListener('click', this._handleListClick.bind(this));
  }

  // ── Geolocation / Map ──────────────────────────────────────────────────────

  _getPosition() {
    if (!navigator.geolocation) return this._showGeoError();
    navigator.geolocation.getCurrentPosition(
      pos => this._initMap([pos.coords.latitude, pos.coords.longitude]),
      () => this._showGeoError()
    );
  }

  _showGeoError() {
    document.querySelector('.geo-error').classList.remove('hidden');
  }

  _initMap(coords) {
    this.#map = L.map('map').setView(coords, this.#mapZoomLevel);
    this._switchTileTheme(document.querySelector('.controls__select--theme').value);
    this.#map.on('click', this._onMapClick.bind(this));
    this.#workouts.forEach(w => this._renderWorkoutMarker(w));
  }

  _onMapClick(mapE) {
    if (this.#routeMode) {
      this._addRoutePoint([mapE.latlng.lat, mapE.latlng.lng]);
    } else {
      this.#mapEvent = mapE;
      this._showForm();
    }
  }

  _switchTileTheme(theme) {
    if (!this.#map) return;
    if (this.#tileLayer) this.#map.removeLayer(this.#tileLayer);

    const tiles = {
      hot: {
        url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
        attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
      satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attr: 'Tiles &copy; Esri',
      },
      dark: {
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        attr: '&copy; <a href="https://carto.com/">CARTO</a>',
      },
    };
    const t = tiles[theme] ?? tiles.hot;
    this.#tileLayer = L.tileLayer(t.url, { attribution: t.attr }).addTo(this.#map);
  }

  _fitBounds() {
    if (!this.#map || !this.#workouts.length) return;
    this.#map.fitBounds(
      this.#workouts.map(w => w.coords),
      { padding: [50, 50] }
    );
  }

  // ── Route drawing ──────────────────────────────────────────────────────────

  _toggleRouteMode() {
    const btn = document.querySelector('.controls__btn--route');
    this.#routeMode = !this.#routeMode;

    if (this.#routeMode) {
      btn.textContent = '✅ Finish route';
      btn.classList.add('controls__btn--active');
      this.#routePoints = [];
    } else {
      btn.textContent = '✏️ Route';
      btn.classList.remove('controls__btn--active');
      if (this.#routePoints.length >= 2) {
        const [lat, lng] = this.#routePoints.at(-1);
        this.#mapEvent = { latlng: { lat, lng } };
        this._showForm();
        this.#inputDistance.value = this._calcRouteDistance(this.#routePoints).toFixed(2);
      } else {
        this._clearRoutePreview();
        this.#routePoints = [];
      }
    }
  }

  _addRoutePoint(coords) {
    this.#routePoints.push(coords);
    this._clearRoutePreview();
    if (this.#routePoints.length > 1) {
      this.#routePreview = L.polyline(this.#routePoints, {
        color: '#00c46a', weight: 3, dashArray: '6 6',
      }).addTo(this.#map);
    }
    const dot = L.circleMarker(coords, { radius: 4, color: '#00c46a', fillOpacity: 1 }).addTo(this.#map);
    this.#routeWaypoints.push(dot);
  }

  _clearRoutePreview() {
    if (this.#routePreview) {
      this.#map.removeLayer(this.#routePreview);
      this.#routePreview = null;
    }
    this.#routeWaypoints.forEach(m => this.#map?.removeLayer(m));
    this.#routeWaypoints = [];
  }

  // ── Form ───────────────────────────────────────────────────────────────────

  _showForm() {
    const workoutsPanel = document.querySelector('.tab-panel--workouts');
    if (workoutsPanel?.classList.contains('hidden')) {
      document.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('tab--active', t.dataset.tab === 'workouts')
      );
      workoutsPanel.classList.remove('hidden');
      document.querySelector('.tab-panel--stats').classList.add('hidden');
    }
    this.#form.classList.remove('hidden');
    this.#inputDistance.focus();
    this._clearFormError();
  }

  _hideForm() {
    this.#inputDistance.value =
      this.#inputDuration.value =
      this.#inputCadence.value =
      this.#inputElevation.value = '';
    // reset to running defaults
    this.#inputType.value = 'running';
    this.#inputCadence.closest('.form__row').classList.remove('form__row--hidden');
    this.#inputElevation.closest('.form__row').classList.add('form__row--hidden');
    [this.#inputDistance, this.#inputDuration, this.#inputCadence, this.#inputElevation]
      .forEach(inp => inp.classList.remove('form__input--invalid'));
    this.#form.classList.add('hidden');
    this.#editingId = null;
    this._clearFormError();

    if (this.#routeMode) {
      this.#routeMode = false;
      this._clearRoutePreview();
      this.#routePoints = [];
      const btn = document.querySelector('.controls__btn--route');
      btn.textContent = '✏️ Route';
      btn.classList.remove('controls__btn--active');
    }
  }

  _toggleElevationField() {
    this.#inputElevation.closest('.form__row').classList.toggle('form__row--hidden');
    this.#inputCadence.closest('.form__row').classList.toggle('form__row--hidden');
  }

  _showFormError(msg) {
    this.#formError.textContent = msg;
    this.#formError.classList.remove('hidden');
  }

  _clearFormError() {
    this.#formError.classList.add('hidden');
  }

  _validateInput(inp) {
    const v = +inp.value;
    if (inp.value.trim() === '') { inp.classList.remove('form__input--invalid'); return; }
    const invalid = !Number.isFinite(v) || (inp !== this.#inputElevation && v <= 0);
    inp.classList.toggle('form__input--invalid', invalid);
  }

  // ── Workout CRUD ───────────────────────────────────────────────────────────

  _newWorkout(e) {
    e.preventDefault();

    const ok = (...vals) => vals.every(v => Number.isFinite(v) && v > 0);
    const type = this.#inputType.value;
    const dist = +this.#inputDistance.value;
    const dur = +this.#inputDuration.value;

    if (this.#editingId) {
      // ── edit existing ──
      const idx = this.#workouts.findIndex(w => w.id === this.#editingId);
      if (idx === -1) return;
      const old = this.#workouts[idx];
      let updated;

      if (type === 'running') {
        const cad = +this.#inputCadence.value;
        if (!ok(dist, dur, cad)) return this._showFormError('All inputs must be positive numbers.');
        updated = new Running(old.coords, dist, dur, cad);
      } else {
        const elev = +this.#inputElevation.value;
        if (!ok(dist, dur) || !Number.isFinite(elev))
          return this._showFormError('All inputs must be positive numbers.');
        updated = new Cycling(old.coords, dist, dur, elev);
      }

      updated.id = old.id;
      updated.date = old.date;
      updated.weather = old.weather;
      updated.route = old.route;
      updated._setDescription();
      this.#workouts[idx] = updated;

      // refresh popup label on the existing marker
      const marker = this.#markers.get(updated.id);
      if (marker)
        marker.setPopupContent(`${updated.type === 'running' ? '🏃‍♂️' : '🚴‍♀️'} ${updated.description}`);

    } else {
      // ── create new ──
      if (!this.#mapEvent) return;
      const { lat, lng } = this.#mapEvent.latlng;
      let workout;

      if (type === 'running') {
        const cad = +this.#inputCadence.value;
        if (!ok(dist, dur, cad)) return this._showFormError('All inputs must be positive numbers.');
        workout = new Running([lat, lng], dist, dur, cad);
      } else {
        const elev = +this.#inputElevation.value;
        if (!ok(dist, dur) || !Number.isFinite(elev))
          return this._showFormError('All inputs must be positive numbers.');
        workout = new Cycling([lat, lng], dist, dur, elev);
      }

      if (this.#routePoints.length >= 2) {
        workout.route = [...this.#routePoints];
        workout.coords = this.#routePoints[0];
        this._clearRoutePreview();
        this.#routePoints = [];
      }

      this.#workouts.push(workout);
      this._renderWorkoutMarker(workout);
      this._fetchWeather(lat, lng, workout.id);
    }

    this._hideForm();
    this._renderWorkoutList();
    this._setLocalStorage();
    this._renderStats();
  }

  _deleteWorkout(id) {
    this.#workouts = this.#workouts.filter(w => w.id !== id);

    const marker = this.#markers.get(id);
    if (marker) { this.#map?.removeLayer(marker); this.#markers.delete(id); }

    const poly = this.#routePolylines.get(id);
    if (poly) { this.#map?.removeLayer(poly); this.#routePolylines.delete(id); }

    this._renderWorkoutList();
    this._setLocalStorage();
    this._renderStats();
  }

  _deleteAllWorkouts() {
    if (!this.#workouts.length) return;
    if (!confirm('Delete all workouts? This cannot be undone.')) return;

    this.#workouts = [];
    this.#markers.forEach(m => this.#map?.removeLayer(m));
    this.#markers.clear();
    this.#routePolylines.forEach(p => this.#map?.removeLayer(p));
    this.#routePolylines.clear();

    this._renderWorkoutList();
    this._setLocalStorage();
    this._renderStats();
  }

  _startEdit(workout) {
    this.#editingId = workout.id;

    this.#inputType.value = workout.type;
    const cadRow = this.#inputCadence.closest('.form__row');
    const elevRow = this.#inputElevation.closest('.form__row');

    if (workout.type === 'running') {
      cadRow.classList.remove('form__row--hidden');
      elevRow.classList.add('form__row--hidden');
      this.#inputCadence.value = workout.cadence;
    } else {
      cadRow.classList.add('form__row--hidden');
      elevRow.classList.remove('form__row--hidden');
      this.#inputElevation.value = workout.elevationGain;
    }

    this.#inputDistance.value = workout.distance;
    this.#inputDuration.value = workout.duration;

    this.#form.classList.remove('hidden');
    this.#inputDistance.focus();
    this._clearFormError();
  }

  // ── Click delegation on workout list ──────────────────────────────────────

  _handleListClick(e) {
    const workoutEl = e.target.closest('.workout');
    if (!workoutEl) return;

    const workout = this.#workouts.find(w => w.id === workoutEl.dataset.id);
    if (!workout) return;

    if (e.target.closest('.workout__delete')) {
      this._deleteWorkout(workout.id);
      return;
    }
    if (e.target.closest('.workout__edit')) {
      this._startEdit(workout);
      return;
    }

    // default: highlight + fit workout on map
    if (!this.#map) return;
    this._highlightWorkout(workout.id);
    this._fitToWorkout(workout);
  }

  _fitToWorkout(workout) {
    const poly = this.#routePolylines.get(workout.id);
    const bounds = poly
      ? poly.getBounds()
      : L.latLng(workout.coords).toBounds(500); // 500m around single marker
    this.#map.fitBounds(bounds, { padding: [60, 60], animate: true });
  }

  _calcRouteDistance(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const [lat1, lng1] = points[i - 1];
      const [lat2, lng2] = points[i];
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
      total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    return total;
  }

  _highlightWorkout(id) {
    this.#workoutsList.querySelectorAll('.workout').forEach(el =>
      el.classList.toggle('workout--active', el.dataset.id === id)
    );
    this.#markers.forEach((marker, markerId) => {
      const el = marker.getElement();
      if (!el) return;
      const active = markerId === id;
      el.classList.toggle('marker--active', active);
      marker.setZIndexOffset(active ? 1000 : 0);
    });
    this.#markers.get(id)?.openPopup();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _applyMapFilter() {
    if (!this.#map) return;
    this.#workouts.forEach(w => {
      const show = this.#currentFilter === 'all' || w.type === this.#currentFilter;
      const marker = this.#markers.get(w.id);
      if (marker) {
        if (show && !this.#map.hasLayer(marker)) marker.addTo(this.#map);
        if (!show && this.#map.hasLayer(marker)) this.#map.removeLayer(marker);
      }
      const poly = this.#routePolylines.get(w.id);
      if (poly) {
        if (show && !this.#map.hasLayer(poly)) poly.addTo(this.#map);
        if (!show && this.#map.hasLayer(poly)) this.#map.removeLayer(poly);
      }
    });
  }

  _getFilteredSorted() {
    let list = this.#currentFilter === 'all'
      ? [...this.#workouts]
      : this.#workouts.filter(w => w.type === this.#currentFilter);

    if (this.#currentSort === 'date') list.sort((a, b) => new Date(b.date) - new Date(a.date));
    else if (this.#currentSort === 'distance') list.sort((a, b) => b.distance - a.distance);
    else if (this.#currentSort === 'duration') list.sort((a, b) => b.duration - a.duration);

    return list;
  }

  _renderWorkoutList() {
    this.#workoutsList.querySelectorAll('.workout').forEach(el => el.remove());

    const list = this._getFilteredSorted();
    this.#emptyState.classList.toggle('hidden', list.length > 0);
    list.forEach(w => this._renderWorkout(w));
  }

  _renderWorkoutMarker(workout) {
    const marker = L.marker(workout.coords)
      .addTo(this.#map)
      .bindPopup(
        L.popup({
          maxWidth: 250, minWidth: 100,
          autoClose: false, closeOnClick: false,
          className: `${workout.type}-popup`,
        })
      )
      .setPopupContent(`${workout.type === 'running' ? '🏃‍♂️' : '🚴‍♀️'} ${workout.description}`)
      .openPopup();

    // click marker → scroll + highlight corresponding card
    marker.on('click', () => {
      const el = this.#workoutsList.querySelector(`[data-id="${workout.id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      this._highlightWorkout(workout.id);
    });

    this.#markers.set(workout.id, marker);

    // draw route polyline if stored
    if (workout.route?.length > 1) {
      const color = workout.type === 'running' ? '#00c46a' : '#ffb545';
      const poly = L.polyline(workout.route, { color, weight: 3, opacity: 0.8 }).addTo(this.#map);
      this.#routePolylines.set(workout.id, poly);
    }
  }

  _renderWorkout(workout) {
    const weatherHtml = workout.weather
      ? `<span class="workout__weather">${workout.weather.icon} ${workout.weather.temp}°C</span>`
      : '';

    let html = `
      <li class="workout workout--${workout.type}" data-id="${workout.id}">
        <div class="workout__header">
          <h2 class="workout__title">${workout.description}</h2>
          <div class="workout__actions">
            ${weatherHtml}
            <button class="workout__btn workout__edit" title="Edit">✏️</button>
            <button class="workout__btn workout__delete" title="Delete">✕</button>
          </div>
        </div>
        <div class="workout__details">
          <span class="workout__icon">${workout.type === 'running' ? '🏃‍♂️' : '🚴‍♀️'}</span>
          <span class="workout__value">${workout.distance}</span>
          <span class="workout__unit">km</span>
        </div>
        <div class="workout__details">
          <span class="workout__icon">⏱</span>
          <span class="workout__value">${workout.duration}</span>
          <span class="workout__unit">min</span>
        </div>`;

    if (workout.type === 'running')
      html += `
        <div class="workout__details">
          <span class="workout__icon">⚡️</span>
          <span class="workout__value">${workout.pace.toFixed(1)}</span>
          <span class="workout__unit">min/km</span>
        </div>
        <div class="workout__details">
          <span class="workout__icon">🦶🏼</span>
          <span class="workout__value">${workout.cadence}</span>
          <span class="workout__unit">spm</span>
        </div>`;

    if (workout.type === 'cycling')
      html += `
        <div class="workout__details">
          <span class="workout__icon">⚡️</span>
          <span class="workout__value">${workout.speed.toFixed(1)}</span>
          <span class="workout__unit">km/h</span>
        </div>
        <div class="workout__details">
          <span class="workout__icon">⛰</span>
          <span class="workout__value">${workout.elevationGain}</span>
          <span class="workout__unit">m</span>
        </div>`;

    html += `</li>`;
    this.#form.insertAdjacentHTML('afterend', html);
  }

  // ── Statistics ─────────────────────────────────────────────────────────────

  _renderStats() {
    if (!this.#workouts.length) {
      if (this.#chart) { this.#chart.destroy(); this.#chart = null; }
      document.querySelector('.stats__value--distance').textContent = '0 km';
      document.querySelector('.stats__value--duration').textContent = '0 min';
      document.querySelector('.stats__value--pace').textContent = '—';
      return;
    }

    const total = (key) => this.#workouts.reduce((s, w) => s + (w[key] ?? 0), 0);
    const runs = this.#workouts.filter(w => w.type === 'running');
    const avgPace = runs.length ? runs.reduce((s, w) => s + w.pace, 0) / runs.length : 0;

    document.querySelector('.stats__value--distance').textContent =
      `${total('distance').toFixed(1)} km`;
    document.querySelector('.stats__value--duration').textContent =
      `${Math.round(total('duration'))} min`;
    document.querySelector('.stats__value--pace').textContent =
      avgPace ? `${avgPace.toFixed(1)} min/km` : '—';

    // render chart only when stats panel is visible (avoids zero-height canvas issue)
    const statsPanel = document.querySelector('.tab-panel--stats');
    if (statsPanel && !statsPanel.classList.contains('hidden')) {
      requestAnimationFrame(() => this._renderChart());
    }
  }

  _renderChart() {
    if (typeof Chart === 'undefined') return;

    const now = new Date();
    let labels, runData, cycleData;

    if (this.#chartPeriod === 'week') {
      labels = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(now);
        d.setDate(d.getDate() - (6 - i));
        return d.toLocaleDateString('en', { weekday: 'short' });
      });
      const dayStrings = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(now);
        d.setDate(d.getDate() - (6 - i));
        return d.toDateString();
      });
      runData = dayStrings.map(ds =>
        this.#workouts
          .filter(w => w.type === 'running' && new Date(w.date).toDateString() === ds)
          .reduce((s, w) => s + w.distance, 0)
      );
      cycleData = dayStrings.map(ds =>
        this.#workouts
          .filter(w => w.type === 'cycling' && new Date(w.date).toDateString() === ds)
          .reduce((s, w) => s + w.distance, 0)
      );
    } else {
      labels = ['4w ago', '3w ago', '2w ago', 'This week'];
      runData = [0, 0, 0, 0];
      cycleData = [0, 0, 0, 0];
      this.#workouts.forEach(w => {
        const weeksAgo = Math.floor((now - new Date(w.date)) / (7 * 24 * 3600 * 1000));
        const idx = 3 - weeksAgo;
        if (idx >= 0 && idx <= 3) {
          if (w.type === 'running') runData[idx] += w.distance;
          else cycleData[idx] += w.distance;
        }
      });
    }

    if (this.#chart) this.#chart.destroy();

    this.#chart = new Chart(this.#statsCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Running (km)',
            data: runData,
            backgroundColor: 'rgba(0,196,106,0.5)',
            borderColor: '#00c46a',
            borderWidth: 1,
          },
          {
            label: 'Cycling (km)',
            data: cycleData,
            backgroundColor: 'rgba(255,181,69,0.5)',
            borderColor: '#ffb545',
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#ececec', font: { size: 11 } } },
        },
        scales: {
          x: { stacked: true, ticks: { color: '#aaa' }, grid: { color: '#42484d' } },
          y: { stacked: true, beginAtZero: true, ticks: { color: '#aaa' }, grid: { color: '#42484d' } },
        },
      },
    });
  }

  // ── Weather (Open-Meteo, no API key required) ──────────────────────────────

  async _fetchWeather(lat, lng, workoutId) {
    try {
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true`
      );
      const { current_weather: cw } = await res.json();
      const workout = this.#workouts.find(w => w.id === workoutId);
      if (!workout) return;
      workout.weather = {
        temp: Math.round(cw.temperature),
        icon: WEATHER_ICONS[cw.weathercode] ?? '🌡️',
      };
      this._setLocalStorage();
      this._renderWorkoutList();
    } catch {
      // weather is optional — ignore network failures silently
    }
  }

  // ── LocalStorage ───────────────────────────────────────────────────────────

  _restoreWorkout(work) {
    let workout;
    if (work.type === 'running')
      workout = new Running(work.coords, work.distance, work.duration, work.cadence);
    else if (work.type === 'cycling')
      workout = new Cycling(work.coords, work.distance, work.duration, work.elevationGain);
    else return null;

    workout.id = work.id;
    workout.date = new Date(work.date);
    workout.weather = work.weather ?? null;
    workout.route = work.route ?? null;
    workout._setDescription();
    return workout;
  }

  _setLocalStorage() {
    localStorage.setItem('workouts', JSON.stringify(this.#workouts));
  }

  _getLocalStorage() {
    const data = JSON.parse(localStorage.getItem('workouts'));
    if (!data) return;
    this.#workouts = data.map(w => this._restoreWorkout(w)).filter(Boolean);
    this._renderWorkoutList();
    this._renderStats();
  }

  reset() {
    localStorage.removeItem('workouts');
    location.reload();
  }
}

const app = new App();

// ── PWA service worker registration ───────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
