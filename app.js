/**
 * SismoInfra Antioquia - Monitor de Afectaciones de Infraestructura
 * Lógica de la aplicación para visualización de mapas y datos en tiempo real
 */

document.addEventListener('DOMContentLoaded', () => {
    // Configuración Global y Estado
    const state = {
        geojsonRaw: null,
        layerMap: {},       // normalizedName -> Leaflet Layer
        markerMap: {},      // normalizedName -> Leaflet Marker
        reports: [],        // List of all active reports
        filteredReports: [], // List of reports after filters are applied
        leafletMap: null,
        geojsonLayer: null,
        markersGroup: null,
        activeFilters: {
            subregion: 'all',
            gravity: 'all',
            search: '',
            damageType: 'all',        // Filtro dinámico por tarjeta de tipo de afectación no vial
            redVialCategory: 'all',   // Filtro dinámico por tarjetas de tipo de Red Vial (Primaria, Secundaria, Terciaria, Urbana)
            tipoRedVial: 'all'        // Filtro por tipo de elemento vial (Puente, Pavimento, etc.)
        },
        selectedMpio: null  // Currently selected municipality normalized name
    };

    // Coordenadas iniciales para centrar Antioquia
    const ANTIOQUIA_CENTER = [6.85, -75.55];
    const INITIAL_ZOOM = 8;

    // Paleta de Colores por Gravedad
    const SEVERITY_COLORS = {
        'Alta': '#ef4444',
        'Media': '#f97316',
        'Baja': '#3b82f6',
        'default': '#9ca3af'
    };

    const SEVERITY_RGBS = {
        'Alta': '239, 68, 68',
        'Media': '249, 115, 22',
        'Baja': '59, 130, 246',
        'default': '156, 163, 175'
    };

    // Referencias a elementos del DOM
    const dom = {
        loadingOverlay: document.getElementById('loading-overlay'),
        loadingStatus: document.getElementById('loading-status'),
        progressBar: document.getElementById('progress-bar'),

        damageTypesGrid: document.getElementById('damage-types-grid'),

        statAffectedCount: document.getElementById('stat-affected-count'),
        statVialCount: document.getElementById('stat-vial-count') || document.getElementById('stat-homes-count'),
        statHighGravity: document.getElementById('stat-high-gravity'),

        searchInput: document.getElementById('search-input'),
        clearSearchBtn: document.getElementById('clear-search-btn'),
        subregionFilter: document.getElementById('subregion-filter'),
        gravityTags: document.querySelectorAll('.gravity-tag'),

        reportsList: document.getElementById('reports-list'),
        visibleReportsCount: document.getElementById('visible-reports-count'),

        infoCard: document.getElementById('info-card'),
        infoSubregion: document.getElementById('info-subregion-text'),
        infoMunicipality: document.getElementById('info-municipality-text'),
        infoHeaderBadgeContainer: document.getElementById('info-header-badge-container'),
        infoCardBodyContainer: document.getElementById('info-card-body-container'),
        closeInfoCardBtn: document.getElementById('close-info-card-btn'),
        zoomToMpioBtn: document.getElementById('zoom-to-mpio-btn'),
        redVialTypesGrid: document.getElementById('red-vial-types-grid'),
        resetMapBtn: document.getElementById('reset-map-btn'),
        exportPdfBtn: document.getElementById('export-pdf-btn')
    };

    /* ==========================================================================
       Helpers & Utility Functions
       ========================================================================== */

    // Normalizar texto para comparación robusta (sin acentos, mayúsculas, espacios limpios)
    function normalizeName(str) {
        if (!str) return '';
        return str.normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toUpperCase()
            .trim();
    }

    // Verificar si el tipo corresponde estrictamente a Infraestructura Vial (Prioritaria)
    function isVialType(typeStr) {
        if (!typeStr) return false;
        const type = normalizeName(typeStr);
        return type.includes('VIAL') || type.includes('CARRETERA') || type === 'INFRAESTRUCTURA VIAL';
    }

    // Retornar color según la gravedad
    function getGravityColor(gravity) {
        return SEVERITY_COLORS[gravity] || SEVERITY_COLORS['default'];
    }

    // Retornar RGB según la gravedad
    function getGravityRgb(gravity) {
        return SEVERITY_RGBS[gravity] || SEVERITY_RGBS['default'];
    }

    // Determinar el nivel de gravedad más alto entre un listado de reportes
    function getHighestGravity(gravities) {
        if (!gravities || gravities.length === 0) return 'Media';
        const weights = { 'Alta': 3, 'Media': 2, 'Baja': 1 };
        let maxWeight = 0;
        let highest = 'Baja';
        gravities.forEach(g => {
            if (!g) return;
            const norm = g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
            const w = weights[norm] || 0;
            if (w > maxWeight) {
                maxWeight = w;
                highest = norm;
            }
        });
        return highest;
    }

    // Normalizar las claves de objetos cargados (ej. CSVs con variaciones en las cabeceras)
    function normalizeLoadedRow(row) {
        const normalized = {};
        for (let key in row) {
            const normKey = normalizeName(key);
            if (normKey === 'MUNICIPIO' || normKey === 'MPIO' || normKey === 'NOMBRE') {
                normalized.Municipio = row[key].trim();
            } else if (normKey === 'SUBREGION' || normKey === 'SUBREG' || normKey === 'ZONA') {
                normalized.Subregion = row[key].trim();
            } else if (normKey === 'TIPO_AFECTACION' || normKey === 'AFECTACION' || normKey === 'TIPO' || normKey === 'DAÑO') {
                normalized.Tipo_Afectacion = row[key].trim();
            } else if (normKey === 'GRAVEDAD' || normKey === 'ALERTA' || normKey === 'SEVERIDAD') {
                // Capitalizar primera letra, resto minúsculas (Alta, Media, Baja)
                const val = row[key].trim().toLowerCase();
                normalized.Gravedad = val.charAt(0).toUpperCase() + val.slice(1);
            } else if (normKey === 'DESCRIPCION' || normKey === 'DESC' || normKey === 'DETALLE') {
                normalized.Descripcion = row[key].trim();
            } else if (normKey === 'RED_VIAL' || normKey === 'RED VIAL') {
                normalized.Red_Vial = row[key].trim();
            } else if (normKey === 'TIPO_RED_VIAL' || normKey === 'TIPO RED VIAL' || normKey === 'TIPO ELEMENTO' || normKey === 'ELEMENTO_VIAL' || normKey === 'ELEMENTO VIAL') {
                normalized.Tipo_Red_Vial = row[key].trim();
            } else if (normKey === 'UBICACION' || normKey === 'SECTOR') {
                normalized.Ubicacion = row[key].trim();
            } else if (normKey.includes('ANOTACION') || normKey.includes('SOLUCION') || normKey.includes('OBSERVACION') || normKey === 'NOTAS') {
                normalized.Anotaciones = row[key].trim();
            }
        }

        // Valores por defecto en caso de faltar
        if (!normalized.Municipio) return null;
        if (!normalized.Subregion) normalized.Subregion = 'Desconocida';
        if (!normalized.Tipo_Afectacion) normalized.Tipo_Afectacion = 'Infraestructura Afectada';
        if (!normalized.Gravedad) normalized.Gravedad = 'Media';
        if (!normalized.Descripcion) normalized.Descripcion = 'Sin descripción detallada disponible.';
        if (!normalized.Anotaciones) normalized.Anotaciones = '';

        return normalized;
    }

    /* ==========================================================================
       Almacenamiento Local de GeoJSON (IndexedDB para Carga Instantánea)
       ========================================================================== */
    function openGeoDatabase() {
        return new Promise((resolve) => {
            if (!window.indexedDB) return resolve(null);
            const request = indexedDB.open('SismoInfraGeoCacheDB', 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('geojsonStore')) {
                    db.createObjectStore('geojsonStore');
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = () => resolve(null);
        });
    }

    async function getCachedGeoJSON() {
        try {
            const db = await openGeoDatabase();
            if (!db) return null;
            return new Promise((resolve) => {
                const tx = db.transaction('geojsonStore', 'readonly');
                const store = tx.objectStore('geojsonStore');
                const req = store.get('antioquia_geojson');
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch (e) {
            return null;
        }
    }

    async function saveCachedGeoJSON(data) {
        try {
            const db = await openGeoDatabase();
            if (!db) return;
            const tx = db.transaction('geojsonStore', 'readwrite');
            const store = tx.objectStore('geojsonStore');
            store.put(data, 'antioquia_geojson');
        } catch (e) {
            console.warn('No se pudo cachear GeoJSON en IndexedDB:', e);
        }
    }

    /* ==========================================================================
       Inicialización del Mapa (Leaflet con Renderizador Canvas Ultra-rápido)
       ========================================================================== */
    function initMap() {
        state.leafletMap = L.map('map', {
            preferCanvas: true, // Renderizado ultra-rápido en Canvas HTML5
            zoomControl: false,
            minZoom: 6,
            maxZoom: 13,
            attributionControl: true
        }).setView(ANTIOQUIA_CENTER, INITIAL_ZOOM);

        // Capa base: CartoDB Dark Matter (Estilo oscuro, premium y minimalista)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(state.leafletMap);

        // Reposicionar controles de zoom abajo a la derecha
        L.control.zoom({
            position: 'bottomright'
        }).addTo(state.leafletMap);

        // Grupo para los marcadores de alerta
        state.markersGroup = L.layerGroup().addTo(state.leafletMap);

        // Añadir las 3 Cordilleras (Occidental, Central, Oriental)
        addCordillerasLayer();

        // Añadir el marcador animado con ondas de choque del epicentro del sismo (San José del Palmar, Chocó)
        addSeismicEpicenterMarker();
    }

    // Renderizar la capa geográfica con las 3 Cordilleras de Colombia que atraviesan Antioquia
    function addCordillerasLayer() {
        if (!state.leafletMap) return;

        state.cordillerasGroup = L.layerGroup(); // Inicialmente oculta, se activa desde la leyenda

        const CORDILLERAS_DATA = [
            {
                name: 'Cordillera Occidental',
                color: '#f97316', // Naranja brillante
                glowColor: 'rgba(249, 115, 22, 0.4)',
                labelPos: [6.60, -76.15],
                points: [
                    [5.40, -76.05],
                    [5.65, -76.08],
                    [5.95, -76.05],
                    [6.25, -76.10],
                    [6.60, -76.15],
                    [7.05, -76.05],
                    [7.65, -76.10]
                ],
                desc: 'Atraviesa el occidente de Antioquia (Nodal de Paramillo, Serranía del Abibe, Farallones del Citará).'
            },
            {
                name: 'Cordillera Central',
                color: '#10b981', // Verde esmeralda
                glowColor: 'rgba(16, 185, 129, 0.4)',
                labelPos: [6.55, -75.45],
                points: [
                    [5.55, -75.60],
                    [5.90, -75.55],
                    [6.25, -75.56],
                    [6.55, -75.45],
                    [6.95, -75.35],
                    [7.35, -75.20]
                ],
                desc: 'Eje montañoso central (Valle de Aburrá, Altiplano de Santa Rosa de Osos, Belmira, Yarumal).'
            }
        ];

        CORDILLERAS_DATA.forEach(cord => {
            // Line 1: Aura / Sombra de resplandor
            L.polyline(cord.points, {
                color: cord.glowColor,
                weight: 8,
                opacity: 0.6,
                lineCap: 'round',
                interactive: false
            }).addTo(state.cordillerasGroup);

            // Line 2: Línea punteada de cresta montañosa
            const mainLine = L.polyline(cord.points, {
                color: cord.color,
                weight: 3,
                dashArray: '8, 6',
                opacity: 0.9,
                lineCap: 'round'
            }).addTo(state.cordillerasGroup);

            mainLine.bindTooltip(`<strong>🏔️ ${cord.name}</strong><br><span style="font-size: 0.7rem; color: #cbd5e1;">${cord.desc}</span>`, {
                sticky: true,
                className: 'cordillera-tooltip'
            });

            // Marcador de Etiqueta con icono de montaña
            const labelHtml = `
                <div class="cordillera-label-badge" style="--cord-color: ${cord.color}">
                    <span>🏔️ ${cord.name}</span>
                </div>
            `;

            const labelIcon = L.divIcon({
                html: labelHtml,
                className: 'cordillera-label-marker',
                iconSize: [140, 24],
                iconAnchor: [70, 12]
            });

            const marker = L.marker(cord.labelPos, { icon: labelIcon, zIndexOffset: 500 }).addTo(state.cordillerasGroup);
            marker.bindTooltip(`<strong>🏔️ ${cord.name}</strong><br><span style="font-size: 0.7rem; color: #cbd5e1;">${cord.desc}</span>`, {
                className: 'cordillera-tooltip'
            });
        });
    }

    // Agregar marcador animado con ondas expansivas del epicentro del sismo SGC
    function addSeismicEpicenterMarker() {
        if (!state.leafletMap) return;

        // Coordenadas del epicentro: San José del Palmar, Chocó (M 7.4, Prof 96km)
        const EPICENTER_COORDS = [4.9744, -76.2292];

        const epicenterHtml = `
            <div class="seismic-epicenter-container" title="Epicentro del Sismo - SGC M 7.4">
                <div class="seismic-wave wave-1"></div>
                <div class="seismic-wave wave-2"></div>
                <div class="seismic-wave wave-3"></div>
                <div class="seismic-wave wave-4"></div>
                <div class="seismic-epicenter-dot">
                    <i data-lucide="zap"></i>
                </div>
            </div>
        `;

        const customIcon = L.divIcon({
            html: epicenterHtml,
            className: 'seismic-epicenter-marker',
            iconSize: [60, 60],
            iconAnchor: [30, 30]
        });

        const epicenterMarker = L.marker(EPICENTER_COORDS, { icon: customIcon, zIndexOffset: 2000 }); // Inicialmente oculta, se activa desde la leyenda

        const popupContent = `
            <div class="epicenter-popup-card">
                <div class="epicenter-badge">
                    <i data-lucide="activity"></i> SGC • EVENTO SÍSMICO PRINCIPAL
                </div>
                <h3>San José del Palmar, Chocó</h3>
                <div class="epicenter-stats-grid">
                    <div class="epicenter-stat-box red">
                        <span class="stat-lbl">MAGNITUD</span>
                        <span class="stat-val">7.4 Mw</span>
                    </div>
                    <div class="epicenter-stat-box orange">
                        <span class="stat-lbl">PROFUNDIDAD</span>
                        <span class="stat-val">96 km</span>
                    </div>
                </div>
                <p class="epicenter-detail-text">
                    De acuerdo con el <strong>Servicio Geológico Colombiano (SGC)</strong>, el sismo tuvo una magnitud de 7,4 y una profundidad de 96 km. La gran magnitud e hipocentro generaron ondas sentidas en todo el departamento de Antioquia y el país.
                </p>
                <button class="btn btn-sm btn-primary btn-block" id="btn-focus-epicenter-popup">
                    ⚡ Encuadrar Municipios Afectados
                </button>
            </div>
        `;

        epicenterMarker.bindPopup(popupContent, {
            maxWidth: 310,
            className: 'epicenter-leaflet-popup'
        });

        epicenterMarker.on('popupopen', () => {
            if (window.lucide) window.lucide.createIcons();
            const btnFocus = document.getElementById('btn-focus-epicenter-popup');
            if (btnFocus) {
                btnFocus.addEventListener('click', () => {
                    fitMapToAffected();
                });
            }
        });

        state.epicenterMarker = epicenterMarker;

        // Bindeo del botón de la barra flotante para volar al epicentro
        const btnFly = document.getElementById('btn-fly-epicenter');
        if (btnFly) {
            btnFly.addEventListener('click', () => {
                const toggleEpicenter = document.getElementById('toggle-layer-epicenter');
                if (toggleEpicenter && !toggleEpicenter.checked) {
                    toggleEpicenter.checked = true;
                }
                if (state.epicenterMarker && !state.leafletMap.hasLayer(state.epicenterMarker)) {
                    state.leafletMap.addLayer(state.epicenterMarker);
                }
                state.leafletMap.flyTo(EPICENTER_COORDS, 9, {
                    duration: 1.5
                });
                setTimeout(() => {
                    epicenterMarker.openPopup();
                }, 1500);
            });
        }
    }

    /* ==========================================================================
       Carga Asíncrona de Municipios (Instantánea mediante Cache IndexedDB)
       ========================================================================== */
    async function loadGeoJson() {
        try {
            // 1. Intentar cargar instantáneamente desde IndexedDB (Cache local)
            const cachedData = await getCachedGeoJSON();
            if (cachedData) {
                console.log('⚡ Coordenadas municipales cargadas instantáneamente desde IndexedDB.');
                state.geojsonRaw = cachedData;
                renderGeoJsonLayer();
                loadDepartmentOutline();
                loadInitialMockData();
                return;
            }

            // 2. Si es la primera vez, cargar en segundo plano sin bloquear la UI
            const response = await fetch('Municipios.geojson');
            if (!response.ok) throw new Error('No se pudo cargar Municipios.geojson');

            const data = await response.json();
            state.geojsonRaw = data;

            renderGeoJsonLayer();
            loadDepartmentOutline();
            loadInitialMockData();

            // 3. Guardar en IndexedDB para aperturas instantáneas futuras
            saveCachedGeoJSON(data);

        } catch (error) {
            console.error('Error cargando GeoJSON:', error);
            loadInitialMockData();
        }
    }

    // Cargar y resaltar el límite externo de Antioquia
    async function loadDepartmentOutline() {
        try {
            const response = await fetch('https://raw.githubusercontent.com/santiblanko/colombia.geojson/master/dpto.json');
            if (!response.ok) throw new Error('No se pudo descargar dpto.json');

            const data = await response.json();
            const antioquiaFeature = data.features.find(f => {
                const code = f.properties.DPTO || f.properties.DPTO_CCDGO || f.properties.dpto;
                return code === '05';
            });

            if (antioquiaFeature) {
                // Dibujar dos capas concéntricas para simular un efecto de "resplandor" o glow premium:

                // 1. Línea externa gruesa translúcida (efecto aura/sombra)
                L.geoJSON(antioquiaFeature, {
                    style: {
                        fillColor: 'transparent',
                        color: 'rgba(59, 130, 246, 0.35)', // Azul de acento translúcido
                        weight: 6,
                        opacity: 0.7,
                        interactive: false
                    }
                }).addTo(state.leafletMap);

                // 2. Línea interna fina de alta intensidad (núcleo del borde)
                L.geoJSON(antioquiaFeature, {
                    style: {
                        fillColor: 'transparent',
                        color: '#60a5fa', // Azul brillante claro
                        weight: 2,
                        opacity: 0.95,
                        interactive: false
                    }
                }).addTo(state.leafletMap);
            }
        } catch (error) {
            console.warn('No se pudo cargar el límite del departamento en línea para resaltar el borde:', error);
        }
    }

    // Renderizar la capa de límites municipales en el mapa
    function renderGeoJsonLayer() {
        if (!state.geojsonRaw) return;

        state.geojsonLayer = L.geoJSON(state.geojsonRaw, {
            style: (feature) => ({
                fillColor: '#161925',
                fillOpacity: 0.45,
                color: 'rgba(255, 255, 255, 0.08)',
                weight: 1,
                className: 'mpio-polygon'
            }),
            onEachFeature: (feature, layer) => {
                const mpioName = feature.properties.MPIO_NOMBR;
                const normalized = normalizeName(mpioName);

                // Guardar referencia de la capa
                state.layerMap[normalized] = layer;

                // Vincular tooltip de hover por defecto
                layer.bindTooltip(mpioName, {
                    direction: 'auto',
                    sticky: true,
                    className: 'mpio-hover-tooltip'
                });

                // Interacciones de la capa
                layer.on({
                    mouseover: (e) => {
                        // Resaltar solo si no está seleccionado
                        if (state.selectedMpio !== normalized) {
                            layer.setStyle({
                                fillColor: 'rgba(59, 130, 246, 0.15)',
                                color: 'rgba(59, 130, 246, 0.5)',
                                weight: 1.5
                            });
                        }
                    },
                    mouseout: (e) => {
                        // Restablecer estilo original si no está seleccionado y no está afectado
                        if (state.selectedMpio !== normalized) {
                            resetLayerStyle(normalized);
                        }
                    },
                    click: (e) => {
                        if (e) {
                            if (e.originalEvent) {
                                L.DomEvent.stopPropagation(e.originalEvent);
                                L.DomEvent.preventDefault(e.originalEvent);
                            }
                            L.DomEvent.stopPropagation(e);
                        }
                        selectMunicipality(normalized, true);
                    }
                });
            }
        }).addTo(state.leafletMap);
    }

    // Restablecer estilo de un municipio a su estado inicial o filtrado
    function resetLayerStyle(normalized) {
        const layer = state.layerMap[normalized];
        if (!layer) return;

        const mpioReports = state.filteredReports.filter(r => normalizeName(r.Municipio) === normalized);
        const rawFeature = state.geojsonRaw ? state.geojsonRaw.features.find(f => normalizeName(f.properties.MPIO_NOMBR) === normalized) : null;
        const mpioName = rawFeature ? rawFeature.properties.MPIO_NOMBR : (mpioReports[0]?.Municipio || normalized);

        if (mpioReports.length > 0) {
            const highestGravity = getHighestGravity(mpioReports.map(r => r.Gravedad));
            const color = getGravityColor(highestGravity);
            layer.setStyle({
                fillColor: color,
                fillOpacity: 0.18,
                color: color,
                weight: 1.5
            });

            // Tooltip informativo con indicación si hay múltiples afectaciones
            const countText = mpioReports.length > 1
                ? `<br><span style="font-size: 0.7rem; color: #fca5a5; font-weight: 600;">⚡ ${mpioReports.length} afectaciones reportadas</span>`
                : `<br><span style="font-size: 0.7rem; color: #cbd5e1;">${mpioReports[0].Tipo_Afectacion}</span>`;

            layer.unbindTooltip();
            layer.bindTooltip(`<strong>${mpioName}</strong>${countText}`, {
                direction: 'auto',
                sticky: true,
                className: 'mpio-hover-tooltip'
            });
        } else {
            layer.setStyle({
                fillColor: '#161925',
                fillOpacity: 0.45,
                color: 'rgba(255, 255, 255, 0.08)',
                weight: 1
            });

            // Restablecer el tooltip al modo hover básico
            layer.unbindTooltip();
            layer.bindTooltip(mpioName, {
                direction: 'auto',
                sticky: true,
                className: 'mpio-hover-tooltip'
            });
        }
    }

    /* ==========================================================================
       Lógica de Carga y Procesamiento de Datos (Afectaciones)
       ========================================================================== */

    // Cargar datos en tiempo real desde Google Sheets (o fallback local) al iniciar
    async function loadInitialMockData() {
        const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1ETyMqVB029hJGHpnuHNE-eTKYoO1oFIroy4rF_UHj2I/export?format=csv';

        try {
            console.log('Intentando conectar con Google Sheets en tiempo real...');
            const response = await fetch(GOOGLE_SHEET_URL_fallback_handler(GOOGLE_SHEET_CSV_URL));
            if (response.ok) {
                const csvText = await response.text();
                parseAndLoadData(csvText, 'csv');
                console.log('Datos cargados exitosamente desde Google Sheets.');

                // Actualizar el texto de estado en el indicador
                const statusText = document.querySelector('.status-text');
                if (statusText) statusText.innerText = 'Google Sheets Conectado';
                return;
            }
            throw new Error('Respuesta HTTP no exitosa al consultar Google Sheets');
        } catch (e) {
            console.warn('Fallo la conexión en vivo con Google Sheets. Cargando base de datos local:', e);

            try {
                const localResponse = await fetch('afectaciones-ejemplo.csv');
                if (localResponse.ok) {
                    const csvText = await localResponse.text();
                    parseAndLoadData(csvText, 'csv');

                    const statusText = document.querySelector('.status-text');
                    if (statusText) statusText.innerText = 'Datos Locales';
                } else {
                    console.warn('No se encontró afectaciones-ejemplo.csv. Se esperará la carga manual del usuario.');
                    updateDashboard();
                }
            } catch (localError) {
                console.error('Error al cargar datos locales de respaldo:', localError);
                updateDashboard();
            }
        }
    }

    // Helper para depuración y formateo del URL de Google Sheet
    function GOOGLE_SHEET_URL_fallback_handler(url) {
        return url; // Retorna el URL de exportación directo
    }

    // Parsear datos de entrada (CSV o JSON)
    function parseAndLoadData(content, format) {
        try {
            let parsedData = [];
            if (format === 'csv') {
                const result = Papa.parse(content, { header: true, skipEmptyLines: true });
                parsedData = result.data;
            } else if (format === 'json') {
                parsedData = JSON.parse(content);
            }

            // Normalizar y limpiar filas
            const cleanReports = parsedData
                .map(row => normalizeLoadedRow(row))
                .filter(row => row !== null);

            if (cleanReports.length === 0) {
                alert('El archivo no contiene registros de municipios válidos.');
                return;
            }

            state.reports = cleanReports;
            state.selectedMpio = null; // Reiniciar selección

            // Actualizar filtros al cargar datos
            if (dom.subregionFilter) dom.subregionFilter.value = 'all';
            state.activeFilters.subregion = 'all';
            state.activeFilters.gravity = 'all';
            state.activeFilters.search = '';
            state.activeFilters.damageType = 'all';
            state.activeFilters.redVialCategory = 'all';
            state.activeFilters.tipoRedVial = 'all';

            updateDashboard();

            // Animación y ajuste de zoom en el mapa para ver los reportes
            fitMapToAffected();

        } catch (e) {
            console.error('Error parseando archivo:', e);
            alert('Error al leer el archivo. Comprueba la estructura del formato.');
        }
    }

    // Ajustar los límites del mapa para encuadrar todos los municipios con reportes activos
    function fitMapToAffected() {
        const activeMpios = state.filteredReports.map(r => normalizeName(r.Municipio));
        if (activeMpios.length === 0) return;

        const bounds = L.latLngBounds();
        let validLayers = 0;

        activeMpios.forEach(mpio => {
            const layer = state.layerMap[mpio];
            if (layer) {
                bounds.extend(layer.getBounds());
                validLayers++;
            }
        });

        if (validLayers > 0) {
            state.leafletMap.flyToBounds(bounds, {
                padding: [50, 50],
                duration: 1.5,
                easeLinearity: 0.25
            });
        }
    }

    /* ==========================================================================
       Actualización de Interfaz y Filtros (Dashboard)
       ========================================================================== */
    function updateDashboard() {
        applyFilters();
        calculateStatistics();
        renderMarkers();
        renderReportsList();
        renderDamageTypeCards();
        renderRedVialTypeCards();
        renderSubregionChart();

        // Restablecer estilos de todas las capas municipales según los filtros actuales
        Object.keys(state.layerMap).forEach(normalized => {
            if (state.selectedMpio !== normalized) {
                resetLayerStyle(normalized);
            }
        });
    }

    // Filtrar los datos en base a los inputs del usuario
    function applyFilters() {
        const { subregion, gravity, search, damageType, redVialCategory, tipoRedVial } = state.activeFilters;

        state.filteredReports = state.reports.filter(report => {
            // Filtro por subregión
            const matchSubregion = subregion === 'all' ||
                normalizeName(report.Subregion) === normalizeName(subregion);

            // Filtro por gravedad
            const matchGravity = gravity === 'all' ||
                report.Gravedad === gravity;

            // Filtro por tipo de afectación (tarjetas interactivas no viales)
            const matchDamageType = damageType === 'all' ||
                normalizeName(report.Tipo_Afectacion) === normalizeName(damageType);

            // Filtro por categoría de Red Vial (Primaria, Secundaria, Terciaria, Urbana)
            let matchRedVialCategory = true;
            if (redVialCategory && redVialCategory !== 'all') {
                const rRedVial = normalizeName(report.Red_Vial || '');
                const rTipoAfect = normalizeName(report.Tipo_Afectacion || '');
                const isVial = isVialType(rTipoAfect) || rRedVial.length > 0;
                matchRedVialCategory = isVial && rRedVial.includes(redVialCategory);
            }

            // Filtro por tipo de elemento red vial
            const matchTipoRedVial = !tipoRedVial || tipoRedVial === 'all' ||
                normalizeName(report.Tipo_Red_Vial || '') === tipoRedVial;

            // Filtro por búsqueda de texto
            const normSearch = normalizeName(search);
            const matchSearch = !normSearch ||
                normalizeName(report.Municipio).includes(normSearch) ||
                normalizeName(report.Subregion).includes(normSearch) ||
                normalizeName(report.Tipo_Afectacion).includes(normSearch) ||
                normalizeName(report.Red_Vial || '').includes(normSearch) ||
                normalizeName(report.Ubicacion || '').includes(normSearch) ||
                normalizeName(report.Anotaciones || '').includes(normSearch);

            return matchSubregion && matchGravity && matchDamageType && matchRedVialCategory && matchTipoRedVial && matchSearch;
        });
    }

    // Calcular y renderizar estadísticas en el panel lateral
    function calculateStatistics() {
        // Municipios únicos afectados por Infraestructura Vial (siempre desde el total de reportes)
        const vialReportsAll = state.reports.filter(r => isVialType(r.Tipo_Afectacion));
        const uniqueVialMpios = new Set(vialReportsAll.map(r => normalizeName(r.Municipio)));
        if (dom.statAffectedCount) dom.statAffectedCount.innerText = uniqueVialMpios.size;
    }

    // Renderizar tarjetas dinámicas por Tipo de Red Vial (Puente, Pavimento Flexible, etc.)
    function renderRedVialTypeCards() {
        if (!dom.redVialTypesGrid) return;
        dom.redVialTypesGrid.innerHTML = '';

        // Solo reportes de Infraestructura Vial que tengan Tipo_Red_Vial
        const vialReports = state.reports.filter(r => isVialType(r.Tipo_Afectacion) && r.Tipo_Red_Vial && r.Tipo_Red_Vial.trim() !== '');

        if (vialReports.length === 0) {
            dom.redVialTypesGrid.innerHTML = '<div class="no-data">Sin elementos viales registrados</div>';
            return;
        }

        // Contar por tipo de elemento vial
        const counts = {};
        vialReports.forEach(r => {
            const tipo = r.Tipo_Red_Vial.trim();
            counts[tipo] = (counts[tipo] || 0) + 1;
        });

        // Ordenar por cantidad descendente
        const tipos = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

        // Mapa de iconos por tipo de elemento
        const iconMap = {
            'PUENTE': 'git-branch',
            'BRIDGE': 'git-branch',
            'PAVIMENTO': 'layers',
            'ASFALTO': 'layers',
            'CARRETERA': 'milestone',
            'VIA': 'milestone',
            'TUNEL': 'circle-dashed',
            'MURO': 'square',
            'TALUD': 'triangle',
            'ALCANTARILLA': 'droplets',
            'DRENAJE': 'droplets',
            'VIADUCTO': 'git-branch',
        };

        function getIconForTipo(tipo) {
            const norm = normalizeName(tipo);
            for (const key in iconMap) {
                if (norm.includes(key)) return iconMap[key];
            }
            return 'construction';
        }

        // Filtro activo de tipo red vial
        const activeRedVialFilter = state.activeFilters.tipoRedVial || 'all';

        tipos.forEach(tipo => {
            const count = counts[tipo];
            const icon = getIconForTipo(tipo);
            const isActive = activeRedVialFilter === normalizeName(tipo);

            const card = document.createElement('div');
            card.className = `red-vial-type-card ${isActive ? 'active' : ''}`;

            card.innerHTML = `
                <div class="red-vial-type-icon-wrapper">
                    <i data-lucide="${icon}"></i>
                </div>
                <div class="red-vial-type-info">
                    <span class="red-vial-type-count">${count}</span>
                    <span class="red-vial-type-label" title="${tipo}">${tipo.toLowerCase()}</span>
                </div>
            `;

            card.addEventListener('click', () => {
                if (isActive) {
                    state.activeFilters.tipoRedVial = 'all';
                } else {
                    state.activeFilters.tipoRedVial = normalizeName(tipo);
                }
                updateDashboard();
            });

            dom.redVialTypesGrid.appendChild(card);
        });

        if (window.lucide) window.lucide.createIcons();
    }

    // Renderizar gráfico interactivo de Afectaciones por Subregión (Oculta subregiones con 0 afectaciones viales)
    function renderSubregionChart() {
        const container = document.getElementById('subregions-chart-container');
        if (!container) return;

        container.innerHTML = '';

        const ALL_SUBREGIONS = [
            'Bajo Cauca', 'Magdalena Medio', 'Nordeste', 'Norte',
            'Occidente', 'Oriente', 'Suroeste', 'Urabá', 'Valle de Aburrá'
        ];

        // Contar reportes de afectaciones viales por subregión
        const subCounts = {};
        ALL_SUBREGIONS.forEach(s => subCounts[s] = 0);

        state.reports.forEach(r => {
            const isVial = isVialType(r.Tipo_Afectacion) || !!r.Red_Vial;
            if (isVial && r.Subregion) {
                if (subCounts.hasOwnProperty(r.Subregion)) {
                    subCounts[r.Subregion]++;
                } else {
                    subCounts[r.Subregion] = (subCounts[r.Subregion] || 0) + 1;
                }
            }
        });

        // Filtrar únicamente las subregiones que tengan al menos 1 afectación vial
        const activeSubregions = Object.keys(subCounts).filter(s => subCounts[s] > 0);

        if (activeSubregions.length === 0) {
            container.innerHTML = '<div class="no-data">Sin afectaciones viales registradas</div>';
            return;
        }

        const activeSubregion = state.activeFilters.subregion || 'all';
        const maxCount = Math.max(...activeSubregions.map(s => subCounts[s]), 1);

        // Ordenar subregiones activas por cantidad descendente
        const sortedSubs = activeSubregions.sort((a, b) => subCounts[b] - subCounts[a]);

        sortedSubs.forEach(sub => {
            const count = subCounts[sub];
            const pct = Math.round((count / maxCount) * 100);
            const isActive = activeSubregion !== 'all' && normalizeName(activeSubregion) === normalizeName(sub);

            const row = document.createElement('div');
            row.className = `subregion-bar-row ${isActive ? 'active' : ''}`;

            row.innerHTML = `
                <div class="subregion-bar-header">
                    <span class="subregion-bar-name">${sub}</span>
                    <span class="subregion-bar-count">${count}</span>
                </div>
                <div class="subregion-bar-track">
                    <div class="subregion-bar-fill" style="width: ${pct}%;"></div>
                </div>
            `;

            row.addEventListener('click', () => {
                if (isActive) {
                    state.activeFilters.subregion = 'all';
                    if (dom.subregionFilter) dom.subregionFilter.value = 'all';
                } else {
                    state.activeFilters.subregion = sub;
                    if (dom.subregionFilter) dom.subregionFilter.value = sub;
                }
                updateDashboard();
            });

            container.appendChild(row);
        });

        // Actualizar opciones del select desplegable de subregiones
        if (dom.subregionFilter) {
            const currentVal = dom.subregionFilter.value;
            dom.subregionFilter.innerHTML = '<option value="all">Todas las Subregiones</option>';
            sortedSubs.forEach(sub => {
                const opt = document.createElement('option');
                opt.value = sub;
                opt.textContent = sub;
                if (normalizeName(currentVal) === normalizeName(sub)) {
                    opt.selected = true;
                }
                dom.subregionFilter.appendChild(opt);
            });
        }
    }

    // Renderizar los marcadores de alerta en el centro geográfico de los municipios afectados (Unificados por municipio)
    function renderMarkers() {
        state.markersGroup.clearLayers();
        state.markerMap = {};

        // Agrupar reportes filtrados por municipio para unificar marcadores en el mapa
        const reportsByMpio = {};
        state.filteredReports.forEach(report => {
            const normalized = normalizeName(report.Municipio);
            if (!reportsByMpio[normalized]) {
                reportsByMpio[normalized] = [];
            }
            reportsByMpio[normalized].push(report);
        });

        Object.keys(reportsByMpio).forEach(normalized => {
            const mpioReports = reportsByMpio[normalized];
            const layer = state.layerMap[normalized];

            if (layer && mpioReports.length > 0) {
                // Obtener el centro del bounding box del polígono municipal
                const center = layer.getBounds().getCenter();
                const count = mpioReports.length;
                const highestGravity = getHighestGravity(mpioReports.map(r => r.Gravedad));
                const color = getGravityColor(highestGravity);
                const hasVial = mpioReports.some(r => isVialType(r.Tipo_Afectacion) || !!r.Red_Vial);
                const mpioName = mpioReports[0].Municipio;

                // Construir etiqueta de indicador para el marcador
                let indicatorLabel = '';
                if (count === 1) {
                    const redVialLabel = mpioReports[0].Red_Vial ? mpioReports[0].Red_Vial : (isVialType(mpioReports[0].Tipo_Afectacion) ? 'VÍA' : mpioReports[0].Tipo_Afectacion);
                    indicatorLabel = `${redVialLabel}<br><span class="vial-marker-mpio">${mpioName}</span>`;
                } else {
                    // Múltiples afectaciones en el mismo municipio (ej. Venecia, Betulia)
                    indicatorLabel = `<span class="marker-count-pill">${count} AFECTACIONES</span><br><span class="vial-marker-mpio">${mpioName}</span>`;
                }

                // HTML Personalizado para el círculo de alerta pulsante
                const markerHtml = `
                    <div class="pulse-marker-wrapper ${hasVial ? 'priority-vial-marker' : ''} ${count > 1 ? 'multi-affectations' : ''}" style="--marker-color: ${color}">
                        <div class="pulse-ring"></div>
                        <div class="pulse-dot" title="${mpioName}: ${count} afectación(es)">
                            ${count > 1 ? `<span class="marker-badge-count">${count}</span>` : ''}
                        </div>
                        <span class="vial-marker-indicator" title="${mpioName}: ${count} afectación(es)">${indicatorLabel}</span>
                    </div>
                `;

                const customIcon = L.divIcon({
                    html: markerHtml,
                    className: `custom-pulse-icon ${hasVial ? 'vial-custom-icon' : ''} ${count > 1 ? 'multi-icon' : ''}`,
                    iconSize: [36, 36],
                    iconAnchor: [18, 18]
                });

                const marker = L.marker(center, { icon: customIcon });

                // Al hacer clic en el marcador, seleccionar el municipio y desplegar el pop up unificado
                marker.on('click', (e) => {
                    if (e) {
                        if (e.originalEvent) {
                            L.DomEvent.stopPropagation(e.originalEvent);
                            L.DomEvent.preventDefault(e.originalEvent);
                        }
                        L.DomEvent.stopPropagation(e);
                    }
                    selectMunicipality(normalized, true);
                });

                marker.addTo(state.markersGroup);
                state.markerMap[normalized] = marker;
            }
        });
    }

    // Renderizar la lista lateral de reportes (ORDENADOS POR PRIORIDAD VIAL)
    function renderReportsList() {
        dom.reportsList.innerHTML = '';
        dom.visibleReportsCount.innerText = state.filteredReports.length;

        // Mostrar barra indicadora de filtro activo con botón de reset si hay filtros seleccionados
        const hasActiveFilter = (state.activeFilters.redVialCategory && state.activeFilters.redVialCategory !== 'all') ||
            (state.activeFilters.subregion && state.activeFilters.subregion !== 'all') ||
            (state.activeFilters.tipoRedVial && state.activeFilters.tipoRedVial !== 'all') ||
            (state.activeFilters.damageType && state.activeFilters.damageType !== 'all');

        if (hasActiveFilter) {
            let activeLabel = 'Filtro activo';
            if (state.activeFilters.redVialCategory && state.activeFilters.redVialCategory !== 'all') {
                activeLabel = `Red Vial ${state.activeFilters.redVialCategory.toLowerCase()}`;
            } else if (state.activeFilters.subregion && state.activeFilters.subregion !== 'all') {
                activeLabel = `Subregión ${state.activeFilters.subregion}`;
            } else if (state.activeFilters.tipoRedVial && state.activeFilters.tipoRedVial !== 'all') {
                activeLabel = `Elemento ${state.activeFilters.tipoRedVial}`;
            }

            const filterBar = document.createElement('div');
            filterBar.className = 'active-filter-bar';
            filterBar.innerHTML = `
                <div class="active-filter-title">
                    <i data-lucide="filter" class="icon-sm"></i>
                    <span>${activeLabel} (${state.filteredReports.length})</span>
                </div>
                <button class="btn-reset-filters" id="reset-all-filters-btn">Limpiar todo</button>
            `;
            filterBar.querySelector('#reset-all-filters-btn').addEventListener('click', () => {
                state.activeFilters.redVialCategory = 'all';
                state.activeFilters.subregion = 'all';
                state.activeFilters.tipoRedVial = 'all';
                state.activeFilters.damageType = 'all';
                if (dom.subregionFilter) dom.subregionFilter.value = 'all';
                updateDashboard();
            });
            dom.reportsList.appendChild(filterBar);
        }

        if (state.filteredReports.length === 0) {
            dom.reportsList.innerHTML += `<div class="no-data">No se encontraron reportes con los filtros seleccionados.</div>`;
            return;
        }

        // Ordenar con PRIORIDAD ABSOLUTA a INFRAESTRUCTURA VIAL, luego por Gravedad
        const gravityWeight = { 'Alta': 3, 'Media': 2, 'Baja': 1 };
        const sortedReports = [...state.filteredReports].sort((a, b) => {
            const aVial = isVialType(a.Tipo_Afectacion);
            const bVial = isVialType(b.Tipo_Afectacion);
            if (aVial && !bVial) return -1;
            if (!aVial && bVial) return 1;

            const gA = gravityWeight[a.Gravedad] || 0;
            const gB = gravityWeight[b.Gravedad] || 0;
            return gB - gA;
        });

        sortedReports.forEach(report => {
            const normalizedName = normalizeName(report.Municipio);
            const color = getGravityColor(report.Gravedad);
            const rgb = getGravityRgb(report.Gravedad);
            const isVial = isVialType(report.Tipo_Afectacion);

            const card = document.createElement('div');
            card.className = `report-card ${state.selectedMpio === normalizedName ? 'active' : ''} ${isVial ? 'priority-vial-card' : ''}`;
            card.style.setProperty('--gravity-color', color);
            card.style.setProperty('--gravity-color-rgb', rgb);

            if (state.selectedMpio === normalizedName) {
                card.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
                card.style.border = `1px solid ${color}`;
            }

            card.innerHTML = `
                <div class="card-header-row">
                    <span class="card-title">${report.Municipio}</span>
                    <div class="card-badges-wrapper">
                        ${report.Red_Vial ? `<span class="card-red-vial-badge">${report.Red_Vial}</span>` : ''}
                        <span class="card-badge">${report.Gravedad}</span>
                    </div>
                </div>
                <div class="card-subregion">${report.Subregion}${report.Ubicacion ? ` • 📍 ${report.Ubicacion}` : ''}</div>
                <div class="card-desc">${report.Tipo_Afectacion} - ${report.Descripcion}</div>
                ${report.Anotaciones ? `<div class="card-anotaciones"><i data-lucide="clipboard-check" class="icon-inline-xs"></i> <strong>Anotación:</strong> ${report.Anotaciones}</div>` : ''}
            `;

            card.addEventListener('click', () => {
                selectMunicipality(normalizedName, true);
            });

            dom.reportsList.appendChild(card);
        });

        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    // Generar y renderizar las tarjetas dinámicas (4 Tarjetas Red Vial + Tipos de Afectación No Viales)
    function renderDamageTypeCards() {
        if (!dom.damageTypesGrid) return;
        dom.damageTypesGrid.innerHTML = '';

        // 1. Renderizar las 4 tarjetas filtro para los tipos de Red Vial (Primaria, Secundaria, Terciaria, Urbana)
        const VIAL_CATEGORIES = [
            { key: 'PRIMARIA', label: 'red vial primaria', icon: 'route', defaultColor: '#ef4444', cssClass: 'cat-primaria' },
            { key: 'SECUNDARIA', label: 'red vial secundaria', icon: 'git-merge', defaultColor: '#3b82f6', cssClass: 'cat-secundaria' },
            { key: 'TERCIARIA', label: 'red vial terciaria', icon: 'trees', defaultColor: '#f97316', cssClass: 'cat-terciaria' },
            { key: 'URBANA', label: 'red vial urbana', icon: 'building-2', defaultColor: '#10b981', cssClass: 'cat-urbana' }
        ];

        VIAL_CATEGORIES.forEach(cat => {
            const catReports = state.reports.filter(r => {
                const isVial = isVialType(r.Tipo_Afectacion) || !!r.Red_Vial;
                const rRedVial = normalizeName(r.Red_Vial || '');
                return isVial && rRedVial.includes(cat.key);
            });

            const count = catReports.length;
            const isActive = state.activeFilters.redVialCategory === cat.key;

            const card = document.createElement('div');
            card.className = `damage-type-card vial-category-card ${cat.cssClass} ${isActive ? 'active' : ''}`;

            card.innerHTML = `
                <div class="damage-type-header">
                    <span class="damage-type-count">${count}</span>
                    <i data-lucide="${cat.icon}" class="damage-type-icon" style="color: ${cat.defaultColor}"></i>
                </div>
                <div class="damage-type-body">
                    <span class="damage-type-label">${cat.label}</span>
                </div>
            `;

            card.addEventListener('click', () => {
                if (state.activeFilters.redVialCategory === cat.key) {
                    state.activeFilters.redVialCategory = 'all';
                } else {
                    state.activeFilters.redVialCategory = cat.key;
                    state.activeFilters.damageType = 'all';
                }
                updateDashboard();
            });

            dom.damageTypesGrid.appendChild(card);
        });

        // 2. Conteo por Tipo_Afectacion excluyendo Infraestructura Vial
        const counts = {};
        state.reports.forEach(report => {
            const type = report.Tipo_Afectacion;
            if (type && !isVialType(type)) {
                counts[type] = (counts[type] || 0) + 1;
            }
        });

        const types = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

        types.forEach(type => {
            const count = counts[type];
            const normalizedType = normalizeName(type);
            const isActive = state.activeFilters.damageType === normalizedType;

            let iconName = 'alert-octagon';
            if (normalizedType.includes('VIVIENDA') || normalizedType.includes('CASA') || normalizedType.includes('TECHO')) {
                iconName = 'home';
            } else if (normalizedType.includes('IGLESIA') || normalizedType.includes('TEMPLO') || normalizedType.includes('CATEDRAL')) {
                iconName = 'church';
            } else if (normalizedType.includes('SALUD') || normalizedType.includes('HOSPITAL') || normalizedType.includes('CLINICA')) {
                iconName = 'heart-pulse';
            } else if (normalizedType.includes('GRIETA') || normalizedType.includes('FACHADA') || normalizedType.includes('MURO')) {
                iconName = 'split';
            } else if (normalizedType.includes('EDUCATIV') || normalizedType.includes('ESCUELA') || normalizedType.includes('COLEGIO')) {
                iconName = 'graduation-cap';
            } else if (normalizedType.includes('HIDRIC') || normalizedType.includes('AGUA') || normalizedType.includes('ACUEDUCTO')) {
                iconName = 'droplets';
            }

            const typeReports = state.reports.filter(r => normalizeName(r.Tipo_Afectacion) === normalizedType);
            const highCount = typeReports.filter(r => r.Gravedad === 'Alta').length;
            const lowCount = typeReports.filter(r => r.Gravedad === 'Baja').length;
            let cardColor = 'var(--accent-orange)';

            if (highCount > typeReports.length / 2) {
                cardColor = 'var(--accent-red)';
            } else if (lowCount > typeReports.length / 2) {
                cardColor = 'var(--accent-blue)';
            }

            const card = document.createElement('div');
            card.className = `damage-type-card ${isActive ? 'active' : ''}`;

            if (isActive) {
                card.style.borderColor = cardColor;
                card.style.boxShadow = `0 0 14px ${cardColor}40`;
                card.style.background = `rgba(255, 255, 255, 0.05)`;
            }

            card.innerHTML = `
                <div class="damage-type-header">
                    <span class="damage-type-count">${count}</span>
                    <i data-lucide="${iconName}" class="damage-type-icon" style="color: ${cardColor}"></i>
                </div>
                <div class="damage-type-body">
                    <span class="damage-type-label">${type.toLowerCase()}</span>
                </div>
            `;

            card.addEventListener('click', () => {
                if (isActive) {
                    state.activeFilters.damageType = 'all';
                } else {
                    state.activeFilters.damageType = normalizedType;
                    state.activeFilters.redVialCategory = 'all';
                }
                updateDashboard();
            });

            dom.damageTypesGrid.appendChild(card);
        });

        // Generar iconos Lucide en las nuevas tarjetas
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    /* ==========================================================================
       Interacciones y Selección de Municipio con Pop up Unificado
       ========================================================================== */
    function selectMunicipality(normalized, flyTo = false) {
        // Deseleccionar el anterior si lo hay
        if (state.selectedMpio) {
            const oldLayer = state.layerMap[state.selectedMpio];
            if (oldLayer) {
                resetLayerStyle(state.selectedMpio);
            }
        }

        state.selectedMpio = normalized;

        const layer = state.layerMap[normalized];
        // Obtener todos los reportes correspondientes a este municipio (priorizando filtrados si aplican)
        const allMpioReports = state.reports.filter(r => normalizeName(r.Municipio) === normalized);
        const filteredMpioReports = state.filteredReports.filter(r => normalizeName(r.Municipio) === normalized);
        const reportsToShow = filteredMpioReports.length > 0 ? filteredMpioReports : allMpioReports;

        if (layer) {
            const highestGravity = reportsToShow.length > 0 ? getHighestGravity(reportsToShow.map(r => r.Gravedad)) : null;
            const color = highestGravity ? getGravityColor(highestGravity) : '#3b82f6';

            // Estilo seleccionado (glowing azul/blanco para indicar selección visual)
            layer.setStyle({
                fillColor: color,
                fillOpacity: reportsToShow.length > 0 ? 0.28 : 0.1,
                color: '#ffffff',
                weight: 2.5
            });
            layer.bringToFront();

            // Al seleccionar, ocultar el tooltip hover
            layer.unbindTooltip();

            if (flyTo) {
                // Volar al municipio seleccionado
                state.leafletMap.flyTo(layer.getBounds().getCenter(), 10, {
                    duration: 1.2
                });
            }
        }

        // Renderizar el pop up / tarjeta de información unificada con todas las afectaciones
        renderInfoCard(normalized, reportsToShow);

        // Resaltar elementos correspondientes en el listado lateral
        const cards = dom.reportsList.querySelectorAll('.report-card');
        let firstActiveCard = null;
        cards.forEach(card => {
            const cardTitle = card.querySelector('.card-title')?.innerText || '';
            if (normalizeName(cardTitle) === normalized) {
                card.classList.add('active');
                card.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
                if (!firstActiveCard) firstActiveCard = card;
            } else {
                card.classList.remove('active');
                card.style.backgroundColor = '';
            }
        });

        if (firstActiveCard) {
            firstActiveCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // En pantallas móviles, si se selecciona un municipio, cambiar automáticamente a la vista de mapa
        if (window.innerWidth <= 900 && state.showMapTab) {
            state.showMapTab();
        }
    }

    // Renderizar en un solo pop up las diferentes afectaciones de un municipio
    function renderInfoCard(normalized, reports) {
        const rawFeature = state.geojsonRaw ? state.geojsonRaw.features.find(f => normalizeName(f.properties.MPIO_NOMBR) === normalized) : null;
        const mpioName = reports.length > 0 ? reports[0].Municipio : (rawFeature ? rawFeature.properties.MPIO_NOMBR : normalized);
        const subregion = reports.length > 0 ? reports[0].Subregion : (rawFeature ? (rawFeature.properties.SUBREGION || 'Antioquia') : 'Antioquia');

        if (dom.infoSubregion) dom.infoSubregion.innerText = subregion;
        if (dom.infoMunicipality) dom.infoMunicipality.innerText = mpioName;

        const badgeContainer = dom.infoHeaderBadgeContainer || document.getElementById('info-header-badge-container');
        const bodyContainer = dom.infoCardBodyContainer || document.getElementById('info-card-body-container');

        if (!bodyContainer) return;

        if (reports.length === 0) {
            if (badgeContainer) {
                badgeContainer.innerHTML = `<span class="gravity-badge" style="background-color: rgba(255,255,255,0.05); color: var(--text-secondary); border: 1px solid var(--border-color);">Nula</span>`;
            }
            bodyContainer.innerHTML = `
                <div class="info-single-report">
                    <div class="info-row">
                        <span class="info-label">Estado de Infraestructura:</span>
                        <span class="info-value highlight">Sin Afectaciones Reportadas</span>
                    </div>
                    <div class="info-desc-box">
                        <p class="info-desc-text">No se registran daños en infraestructura ni alertas de emergencia para este municipio.</p>
                    </div>
                </div>
            `;
        } else if (reports.length === 1) {
            const report = reports[0];
            const color = getGravityColor(report.Gravedad);
            const rgb = getGravityRgb(report.Gravedad);

            if (badgeContainer) {
                badgeContainer.innerHTML = `<span class="gravity-badge" style="background-color: rgba(${rgb}, 0.15); color: ${color}; border: 1px solid ${color};">${report.Gravedad}</span>`;
            }

            bodyContainer.innerHTML = `
                <div class="info-single-report">
                    <div class="info-row">
                        <span class="info-label">Tipo de Afectación:</span>
                        <div class="info-type-header-row">
                            <span class="info-value highlight">${report.Tipo_Afectacion}</span>
                            ${report.Tipo_Red_Vial ? `<span class="info-tipo-badge">${report.Tipo_Red_Vial}</span>` : ''}
                        </div>
                    </div>
                    ${report.Red_Vial ? `
                        <div class="info-row">
                            <span class="info-label">Red Vial:</span>
                            <span class="card-red-vial-badge align-self-start">${report.Red_Vial}</span>
                        </div>
                    ` : ''}
                    ${report.Ubicacion ? `
                        <div class="info-row">
                            <span class="info-label">Ubicación / Sector:</span>
                            <span class="info-value"><i data-lucide="map-pin" class="icon-inline-xs"></i> ${report.Ubicacion}</span>
                        </div>
                    ` : ''}
                    <div class="info-desc-box">
                        <span class="info-label">Descripción del Impacto:</span>
                        <p class="info-desc-text">${report.Descripcion}</p>
                    </div>
                    ${report.Anotaciones && report.Anotaciones.trim() !== '' ? `
                        <div class="info-desc-box info-anotaciones-box">
                            <span class="info-label"><i data-lucide="clipboard-check" class="icon-inline"></i> Anotaciones / Soluciones:</span>
                            <p class="info-desc-text info-anotaciones-text">${report.Anotaciones}</p>
                        </div>
                    ` : ''}
                </div>
            `;
        } else {
            // Múltiples afectaciones en el mismo municipio (ej. Venecia, Betulia)
            if (badgeContainer) {
                badgeContainer.innerHTML = `
                    <span class="multi-count-badge" title="Municipio con ${reports.length} afectaciones registradas">
                        <i data-lucide="layers" class="icon-inline-xs"></i> ${reports.length} Afectaciones
                    </span>
                `;
            }

            bodyContainer.innerHTML = `
                <div class="info-multi-reports-list scrollbar-custom">
                    ${reports.map((report, idx) => {
                        const color = getGravityColor(report.Gravedad);
                        const rgb = getGravityRgb(report.Gravedad);
                        return `
                            <div class="info-report-item-card" style="--item-gravity-color: ${color};">
                                <div class="info-item-card-header">
                                    <span class="info-item-index">Afectación #${idx + 1}</span>
                                    <div class="info-item-badges">
                                        ${report.Red_Vial ? `<span class="card-red-vial-badge">${report.Red_Vial}</span>` : ''}
                                        ${report.Tipo_Red_Vial ? `<span class="info-tipo-badge">${report.Tipo_Red_Vial}</span>` : ''}
                                        <span class="gravity-badge" style="background-color: rgba(${rgb}, 0.15); color: ${color}; border: 1px solid ${color};">${report.Gravedad}</span>
                                    </div>
                                </div>
                                <div class="info-item-type-title">${report.Tipo_Afectacion}</div>
                                ${report.Ubicacion ? `
                                    <div class="info-item-ubicacion-row">
                                        <i data-lucide="map-pin" class="icon-inline-xs"></i>
                                        <span><strong>Ubicación:</strong> ${report.Ubicacion}</span>
                                    </div>
                                ` : ''}
                                <div class="info-item-desc-box">
                                    <p class="info-desc-text">${report.Descripcion}</p>
                                </div>
                                ${report.Anotaciones && report.Anotaciones.trim() !== '' ? `
                                    <div class="info-desc-box info-anotaciones-box">
                                        <span class="info-label"><i data-lucide="clipboard-check" class="icon-inline"></i> Anotaciones / Soluciones:</span>
                                        <p class="info-desc-text info-anotaciones-text">${report.Anotaciones}</p>
                                    </div>
                                ` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }

        if (window.lucide) window.lucide.createIcons();
        if (dom.infoCard) dom.infoCard.classList.remove('hidden');
    }

    function deselectAll() {
        if (state.selectedMpio) {
            const oldMpio = state.selectedMpio;
            state.selectedMpio = null;
            resetLayerStyle(oldMpio);
        }
        if (dom.infoCard) dom.infoCard.classList.add('hidden');

        const cards = dom.reportsList.querySelectorAll('.report-card');
        cards.forEach(card => {
            card.classList.remove('active');
            card.style.backgroundColor = '';
        });
    }

    /* ==========================================================================
       Navegación Móvil Adaptativa (Tabs / Drawer)
       ========================================================================== */
    function setupMobileNav() {
        const tabMapBtn = document.getElementById('tab-map-btn');
        const tabListBtn = document.getElementById('tab-list-btn');
        const sidebar = document.querySelector('.sidebar');

        if (!tabMapBtn || !tabListBtn || !sidebar) return;

        function showMapTab() {
            tabMapBtn.classList.add('active');
            tabListBtn.classList.remove('active');
            sidebar.classList.add('mobile-hidden');
            if (state.leafletMap) {
                setTimeout(() => state.leafletMap.invalidateSize(), 300);
            }
        }

        function showListTab() {
            tabListBtn.classList.add('active');
            tabMapBtn.classList.remove('active');
            sidebar.classList.remove('mobile-hidden');
        }

        tabMapBtn.addEventListener('click', showMapTab);
        tabListBtn.addEventListener('click', showListTab);

        state.showMapTab = showMapTab;

        // En pantallas móviles (<= 900px), iniciar en vista de mapa
        if (window.innerWidth <= 900) {
            sidebar.classList.add('mobile-hidden');
        }

        window.addEventListener('resize', () => {
            if (window.innerWidth > 900) {
                sidebar.classList.remove('mobile-hidden');
            } else if (!tabListBtn.classList.contains('active')) {
                sidebar.classList.add('mobile-hidden');
            }
        });
    }

    /* ==========================================================================
       Manejadores de Eventos del DOM y UI
       ========================================================================== */

    // Configurar filtros y buscador de la UI
    function setupFilters() {
        if (dom.subregionFilter) {
            dom.subregionFilter.addEventListener('change', (e) => {
                state.activeFilters.subregion = e.target.value;
                updateDashboard();
            });
        }
    }

    // Interacciones adicionales de los botones
    function setupInteractions() {
        // Cerrar tarjeta flotante de info
        dom.closeInfoCardBtn.addEventListener('click', () => {
            deselectAll();
        });

        // Alinear zoom sobre municipio seleccionado
        dom.zoomToMpioBtn.addEventListener('click', () => {
            if (state.selectedMpio) {
                const layer = state.layerMap[state.selectedMpio];
                if (layer) {
                    state.leafletMap.flyToBounds(layer.getBounds(), {
                        maxZoom: 11,
                        duration: 1
                    });
                }
            }
        });

        // Botón flotante para restablecer la vista completa de Antioquia
        dom.resetMapBtn.addEventListener('click', () => {
            deselectAll();

            if (state.filteredReports.length > 0) {
                fitMapToAffected();
            } else if (state.geojsonLayer) {
                state.leafletMap.flyToBounds(state.geojsonLayer.getBounds(), {
                    duration: 1.2
                });
            } else {
                state.leafletMap.flyTo(ANTIOQUIA_CENTER, INITIAL_ZOOM, {
                    duration: 1.2
                });
            }
        });

        // Botón flotante para exportar reporte PDF de infraestructura vial
        if (dom.exportPdfBtn) {
            dom.exportPdfBtn.addEventListener('click', exportVialPdfReport);
        }

        // Control de Capas desde la Leyenda: Cordilleras
        const toggleCordilleras = document.getElementById('toggle-layer-cordilleras');
        if (toggleCordilleras) {
            toggleCordilleras.checked = false;
            toggleCordilleras.addEventListener('change', (e) => {
                if (e.target.checked) {
                    if (state.cordillerasGroup && !state.leafletMap.hasLayer(state.cordillerasGroup)) {
                        state.leafletMap.addLayer(state.cordillerasGroup);
                    }
                } else {
                    if (state.cordillerasGroup && state.leafletMap.hasLayer(state.cordillerasGroup)) {
                        state.leafletMap.removeLayer(state.cordillerasGroup);
                    }
                }
            });
        }

        // Control de Capas desde la Leyenda: Epicentro del Sismo
        const toggleEpicenter = document.getElementById('toggle-layer-epicenter');
        const epicenterBanner = document.getElementById('epicenter-floating-banner');
        if (toggleEpicenter) {
            toggleEpicenter.checked = false;
            toggleEpicenter.addEventListener('change', (e) => {
                if (e.target.checked) {
                    if (state.epicenterMarker && !state.leafletMap.hasLayer(state.epicenterMarker)) {
                        state.leafletMap.addLayer(state.epicenterMarker);
                    }
                    if (epicenterBanner) epicenterBanner.classList.remove('hidden');
                } else {
                    if (state.epicenterMarker && state.leafletMap.hasLayer(state.epicenterMarker)) {
                        state.leafletMap.removeLayer(state.epicenterMarker);
                    }
                    if (epicenterBanner) epicenterBanner.classList.add('hidden');
                }
            });
        }

        // Minimizar / Expandir Panel de Leyenda
        const btnLegendCollapse = document.getElementById('btn-legend-collapse');
        const legendPanelHeader = document.getElementById('legend-panel-header');
        const legendPanelBody = document.getElementById('legend-panel-body');
        if (legendPanelHeader && legendPanelBody) {
            legendPanelHeader.addEventListener('click', () => {
                legendPanelBody.classList.toggle('collapsed');
                if (btnLegendCollapse) btnLegendCollapse.classList.toggle('rotated');
            });
        }

        // Clicar fuera de los municipios para deseleccionar
        state.leafletMap.on('click', () => {
            deselectAll();
        });
    }

    /* ==========================================================================
       Generación de Mapa Canvas y Reporte PDF (Infraestructura Vial)
       ========================================================================== */

    /* ==========================================================================
       Generación de Mapa y Gráficos Nativos Vectoriales para PDF (100% Vectorial)
       ========================================================================== */

    // Dibujar Mapa Vectorial de Antioquia en PDF (Limpio, sin fondo ni cuadrículas, puntos compactos)
    function drawAntioquiaVectorMap(doc, mapX, mapY, mapWidth, mapHeight, vialReports) {
        if (!state.geojsonRaw || !state.geojsonRaw.features) return;

        // Bounding Box del GeoJSON
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;

        function extractPoints(geometry) {
            const pts = [];
            if (geometry.type === 'Polygon') {
                geometry.coordinates.forEach(ring => ring.forEach(pt => pts.push(pt)));
            } else if (geometry.type === 'MultiPolygon') {
                geometry.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(pt => pts.push(pt))));
            }
            return pts;
        }

        state.geojsonRaw.features.forEach(feature => {
            if (!feature.geometry) return;
            const points = extractPoints(feature.geometry);
            points.forEach(([lng, lat]) => {
                if (lng < minLng) minLng = lng;
                if (lng > maxLng) maxLng = lng;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
            });
        });

        if (minLng === Infinity) return;

        const mapPadding = 4;
        const innerWidth = mapWidth - mapPadding * 2;
        const innerHeight = mapHeight - mapPadding * 2;

        const lngSpan = maxLng - minLng;
        const latSpan = maxLat - minLat;

        const scale = Math.min(innerWidth / lngSpan, innerHeight / latSpan);
        const xOffset = mapX + mapPadding + (innerWidth - lngSpan * scale) / 2;
        const yOffset = mapY + mapPadding + (innerHeight - latSpan * scale) / 2;

        function project(lng, lat) {
            const x = xOffset + (lng - minLng) * scale;
            const y = yOffset + (maxLat - lat) * scale;
            return [x, y];
        }

        // Mapa de municipios afectados
        const affectedMap = {};
        vialReports.forEach(r => {
            affectedMap[normalizeName(r.Municipio)] = r;
        });

        // 1. Dibujar Polígonos de Municipios (Limpio, sin fondo ni líneas cuadrícula en el mapa)
        state.geojsonRaw.features.forEach(feature => {
            if (!feature.geometry) return;
            const mpioNameNorm = normalizeName(feature.properties.MPIO_NOMBR || '');
            const isAffected = affectedMap.hasOwnProperty(mpioNameNorm);

            const polygons = feature.geometry.type === 'Polygon'
                ? [feature.geometry.coordinates]
                : feature.geometry.coordinates;

            polygons.forEach(polygon => {
                polygon.forEach(ring => {
                    if (ring.length < 3) return;
                    const ringPdf = ring.map(([lng, lat]) => project(lng, lat));
                    const startX = ringPdf[0][0];
                    const startY = ringPdf[0][1];

                    const relativeLines = [];
                    for (let i = 1; i < ringPdf.length; i++) {
                        const dx = ringPdf[i][0] - ringPdf[i - 1][0];
                        const dy = ringPdf[i][1] - ringPdf[i - 1][1];
                        relativeLines.push([dx, dy]);
                    }

                    if (isAffected) {
                        doc.setFillColor(254, 226, 226); // Rojo suave #fee2e2
                        doc.setDrawColor(239, 68, 68); // Borde rojo tenue #ef4444
                        doc.setLineWidth(0.2);
                    } else {
                        doc.setFillColor(248, 250, 252); // Gris claro limpio #f8fafc
                        doc.setDrawColor(203, 213, 225); // Borde gris suave #cbd5e1
                        doc.setLineWidth(0.1);
                    }

                    doc.lines(relativeLines, startX, startY, [1, 1], 'FD', true);
                });
            });
        });

        // 2. Dibujar Puntos Rojos Compactos y Fines e Identificadores
        state.geojsonRaw.features.forEach(feature => {
            if (!feature.geometry) return;
            const mpioName = feature.properties.MPIO_NOMBR || '';
            const mpioNameNorm = normalizeName(mpioName);
            if (!affectedMap.hasOwnProperty(mpioNameNorm)) return;

            const pts = extractPoints(feature.geometry);
            let sumX = 0, sumY = 0;
            pts.forEach(([lng, lat]) => {
                const [px, py] = project(lng, lat);
                sumX += px;
                sumY += py;
            });
            const cX = sumX / pts.length;
            const cY = sumY / pts.length;

            // Punto rojo compacto (radio 1.1mm)
            doc.setFillColor(239, 68, 68);
            doc.circle(cX, cY, 1.1, 'F');

            // Punto central blanco fino
            doc.setFillColor(255, 255, 255);
            doc.circle(cX, cY, 0.4, 'F');

            // Nombre del municipio en fuente pequeña y legible
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(5);
            doc.setTextColor(30, 41, 59); // #1e293b
            doc.text(mpioName, cX, cY - 1.8, { align: 'center' });
        });

        // 2.5 Dibujar las Cordilleras de los Andes en Vector PDF (Solo si la capa está encendida)
        const cordillerasCheckbox = document.getElementById('toggle-layer-cordilleras');
        const isCordillerasActive = cordillerasCheckbox ? cordillerasCheckbox.checked : (state.leafletMap && state.cordillerasGroup && state.leafletMap.hasLayer(state.cordillerasGroup));

        if (isCordillerasActive) {
            const CORDILLERAS_PDF = [
                { name: 'Cord. Occidental', pts: [[5.65, -76.08], [6.25, -76.10], [6.60, -76.15], [7.05, -76.05]], color: [249, 115, 22] },
                { name: 'Cord. Central', pts: [[5.55, -75.60], [6.25, -75.56], [6.55, -75.45], [7.35, -75.20]], color: [16, 185, 129] }
            ];

            CORDILLERAS_PDF.forEach(cord => {
                const pdfPts = cord.pts.map(([lat, lng]) => project(lng, lat));
                doc.setDrawColor(...cord.color);
                doc.setLineWidth(0.3);
                for (let i = 1; i < pdfPts.length; i++) {
                    doc.line(pdfPts[i - 1][0], pdfPts[i - 1][1], pdfPts[i][0], pdfPts[i][1]);
                }
                const mid = pdfPts[Math.floor(pdfPts.length / 2)];
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(4.5);
                doc.setTextColor(...cord.color);
                doc.text(`🏔️ ${cord.name}`, mid[0], mid[1] - 1);
            });
        }

        // 2.6 Dibujar el Epicentro del Sismo en Vector PDF (Solo si la capa está encendida)
        const epicenterCheckbox = document.getElementById('toggle-layer-epicenter');
        const isEpicenterActive = epicenterCheckbox ? epicenterCheckbox.checked : (state.leafletMap && state.epicenterMarker && state.leafletMap.hasLayer(state.epicenterMarker));

        if (isEpicenterActive) {
            const EPICENTER_LATLNG = [4.9744, -76.2292];
            const [eX, eY] = project(EPICENTER_LATLNG[1], EPICENTER_LATLNG[0]);

            if (eX >= mapX && eX <= mapX + mapWidth && eY >= mapY && eY <= mapY + mapHeight) {
                // Ondas concéntricas sismo
                doc.setDrawColor(239, 68, 68);
                doc.setLineWidth(0.2);
                doc.circle(eX, eY, 3.5, 'D');
                doc.circle(eX, eY, 2.0, 'D');

                // Punto central
                doc.setFillColor(239, 68, 68);
                doc.circle(eX, eY, 1.2, 'F');
                doc.setFillColor(255, 255, 255);
                doc.circle(eX, eY, 0.4, 'F');

                doc.setFont('helvetica', 'bold');
                doc.setFontSize(4.5);
                doc.setTextColor(239, 68, 68);
                doc.text('⚡ Epicentro SGC M 7.4', eX, eY - 4.2, { align: 'center' });
            }
        }

        // 3. Leyenda del Mapa Vectorial (Estilo limpio blanco)
        const legX = mapX + mapWidth - 52;
        const legY = mapY + mapHeight - 14;
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(203, 213, 225);
        doc.setLineWidth(0.2);
        doc.roundedRect(legX, legY, 50, 12, 1.5, 1.5, 'FD');

        doc.setFillColor(239, 68, 68);
        doc.circle(legX + 4, legY + 4, 1.0, 'F');
        doc.setFillColor(255, 255, 255);
        doc.circle(legX + 4, legY + 4, 0.4, 'F');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(5.5);
        doc.setTextColor(30, 41, 59);
        doc.text('Municipio con daño vial', legX + 7.5, legY + 4.8);

        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(203, 213, 225);
        doc.rect(legX + 3, legY + 7.5, 2, 2, 'FD');
        doc.setFont('helvetica', 'normal');
        doc.text('Límite municipal Antioquia', legX + 7.5, legY + 9.2);
    }

    // Dibujar Gráfico Vectorial de Subregiones en PDF (Estilo limpio)
    function drawSubregionVectorChart(doc, chartX, chartY, chartWidth, vialReports) {
        const ALL_SUBREGIONS = [
            'Bajo Cauca', 'Magdalena Medio', 'Nordeste', 'Norte',
            'Occidente', 'Oriente', 'Suroeste', 'Urabá', 'Valle de Aburrá'
        ];

        const subCounts = {};
        ALL_SUBREGIONS.forEach(s => subCounts[s] = 0);

        vialReports.forEach(r => {
            if (r.Subregion) {
                if (subCounts.hasOwnProperty(r.Subregion)) {
                    subCounts[r.Subregion]++;
                } else {
                    subCounts[r.Subregion] = (subCounts[r.Subregion] || 0) + 1;
                }
            }
        });

        const activeSubregions = Object.keys(subCounts).filter(s => subCounts[s] > 0);
        if (activeSubregions.length === 0) return 0;

        activeSubregions.sort((a, b) => subCounts[b] - subCounts[a]);
        const maxCount = Math.max(...activeSubregions.map(s => subCounts[s]), 1);

        const rowHeight = 5.5; // mm
        const topPadding = 9;  // mm
        const bottomPadding = 3.5; // mm
        const chartHeight = topPadding + activeSubregions.length * rowHeight + bottomPadding;

        // Contenedor del gráfico (Fondo limpio blanco)
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(203, 213, 225);
        doc.setLineWidth(0.25);
        doc.roundedRect(chartX, chartY, chartWidth, chartHeight, 2, 2, 'FD');

        // Línea roja de acento del título
        doc.setFillColor(239, 68, 68);
        doc.rect(chartX + 5, chartY + 4.5, 20, 0.6, 'F');

        // Título del gráfico
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(15, 23, 42);
        doc.text('RESUMEN DE AFECTACIONES VIALES POR SUBREGIÓN', chartX + 28, chartY + 5.5);

        const labelX = chartX + 5;
        const barStartX = chartX + 42;
        const maxBarWidth = chartWidth - 56; // mm

        activeSubregions.forEach((sub, idx) => {
            const count = subCounts[sub];
            const y = chartY + topPadding + idx * rowHeight;
            const barWidth = Math.max((count / maxCount) * maxBarWidth, 2.5);

            // Nombre de la Subregión
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(6.5);
            doc.setTextColor(30, 41, 59);
            doc.text(sub, labelX, y + 3.8);

            // Pista del fondo de la barra
            doc.setFillColor(241, 245, 249); // #f1f5f9
            doc.roundedRect(barStartX, y + 1, maxBarWidth, 3.2, 0.8, 0.8, 'F');

            // Barra vectorial con color azul acento
            doc.setFillColor(59, 130, 246);
            doc.roundedRect(barStartX, y + 1, barWidth, 3.2, 0.8, 0.8, 'F');

            // Etiqueta numérica del conteo
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(6.5);
            doc.setTextColor(30, 41, 59);
            doc.text(`${count}`, barStartX + barWidth + 2.5, y + 3.8);
        });

        return chartHeight;
    }

    // Exportar el reporte en PDF de Infraestructura Vial
    function exportVialPdfReport() {
        // Filtrar reportes que corresponden exclusivamente a Infraestructura Vial
        const vialReports = state.reports.filter(r => isVialType(r.Tipo_Afectacion));

        if (vialReports.length === 0) {
            alert('No se registran afectaciones de Infraestructura Vial en la base de datos actual.');
            return;
        }

        // Verificar que jsPDF esté disponible
        if (!window.jspdf || !window.jspdf.jsPDF) {
            alert('La librería de generación de PDF aún se está cargando. Por favor intenta de nuevo en unos segundos.');
            return;
        }

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4'
        });

        const now = new Date();
        const dateStr = now.toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });
        const timeStr = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

        // --- ENCABEZADO Y HEADER OFICIAL ---
        doc.setFillColor(15, 23, 42); // #0f172a
        doc.rect(0, 0, 210, 36, 'F');

        // Banda roja de acento
        doc.setFillColor(239, 68, 68); // #ef4444
        doc.rect(0, 36, 210, 3, 'F');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.setTextColor(255, 255, 255);
        doc.text('REPORTE DE AFECTACIÓN - INFRAESTRUCTURA VIAL', 14, 16);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(203, 213, 225);
        doc.text('Secretaría de Infraestructura Física - Gobernación de Antioquia', 14, 23);

        doc.setFontSize(8);
        doc.setTextColor(148, 163, 184);
        const uniqueVialMpiosCount = new Set(vialReports.map(r => normalizeName(r.Municipio))).size;
        doc.text(`Fecha de emisión: ${dateStr} - ${timeStr} | Afectaciones registradas: ${vialReports.length} (${uniqueVialMpiosCount} municipios)`, 14, 30);

        // --- SECCIÓN 1: MAPA GENERAL VECTORIAL ---
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        doc.text('1. Mapa General de Afectaciones Viales en Antioquia', 14, 44);

        const mapX = 14;
        const mapY = 47;
        const mapWidth = 182;
        const mapHeight = 98;

        drawAntioquiaVectorMap(doc, mapX, mapY, mapWidth, mapHeight, vialReports);

        // --- SECCIÓN 2: GRÁFICO DE SUBREGIONES VECTORIAL ---
        const chartY = mapY + mapHeight + 6; // 151 mm
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        doc.text('2. Resumen de Afectaciones Viales por Subregión', 14, chartY - 2);

        const chartHeight = drawSubregionVectorChart(doc, 14, chartY, 182, vialReports);
        const nextY = chartY + chartHeight + 6;

        // --- SECCIÓN 3: LISTADO DETALLADO DE AFECTACIONES VIALES ---
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        doc.text('3. Listado Detallado de Afectaciones a la Red Vial', 14, nextY);

        const tableBody = vialReports.map((r, idx) => [
            (idx + 1).toString(),
            r.Municipio || '-',
            r.Subregion || '-',
            r.Red_Vial || '-',
            r.Tipo_Red_Vial || '-',
            r.Descripcion || 'Sin descripción disponible',
            (r.Anotaciones && r.Anotaciones.trim()) ? r.Anotaciones.trim() : '-'
        ]);

        doc.autoTable({
            startY: nextY + 3,
            head: [['N°', 'Municipio', 'Subregión', 'Red Vial', 'Tipo elemento vial', 'Descripción del Impacto', 'Anotaciones y/o Soluciones']],
            body: tableBody,
            theme: 'grid',
            headStyles: {
                fillColor: [239, 68, 68],
                textColor: [255, 255, 255],
                fontStyle: 'bold',
                fontSize: 7.5,
                halign: 'center'
            },
            bodyStyles: {
                fontSize: 7,
                cellPadding: 2,
                textColor: [30, 41, 59]
            },
            columnStyles: {
                0: { cellWidth: 8, halign: 'center' },
                1: { cellWidth: 24, fontStyle: 'bold' },
                2: { cellWidth: 20 },
                3: { cellWidth: 22 },
                4: { cellWidth: 24 },
                5: { cellWidth: 42 },
                6: { cellWidth: 42 }
            },
            alternateRowStyles: {
                fillColor: [248, 250, 252]
            }
        });

        // Pie de página en todas las páginas
        const pageCount = doc.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(148, 163, 184);
            doc.text(`SismoInfra Antioquia - Monitoreo Oficial de Emergencias Viales`, 14, 290);
            doc.text(`Página ${i} de ${pageCount}`, 196, 290, { align: 'right' });
        }

        // Descargar PDF
        const fileName = `Reporte_Infraestructura_Vial_Antioquia_${now.toISOString().slice(0, 10)}.pdf`;
        doc.save(fileName);
    }

    /* ==========================================================================
       Inicialización de la Aplicación
       ========================================================================== */
    function init() {
        initMap();
        setupMobileNav();
        setupFilters();
        setupInteractions();

        // Cargar el GeoJSON
        loadGeoJson();

        // Inicializar iconos Lucide
        lucide.createIcons();
    }

    init();
});
