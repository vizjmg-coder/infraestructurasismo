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
        infoType: document.getElementById('info-type-text'),
        infoGravity: document.getElementById('info-gravity-text'),
        infoRedVialRow: document.getElementById('info-red-vial-row'),
        infoRedVialText: document.getElementById('info-red-vial-text'),
        infoUbicacionRow: document.getElementById('info-ubicacion-row'),
        infoUbicacionText: document.getElementById('info-ubicacion-text'),
        infoDesc: document.getElementById('info-desc-text'),
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
            }
        }
        
        // Valores por defecto en caso de faltar
        if (!normalized.Municipio) return null;
        if (!normalized.Subregion) normalized.Subregion = 'Desconocida';
        if (!normalized.Tipo_Afectacion) normalized.Tipo_Afectacion = 'Infraestructura Afectada';
        if (!normalized.Gravedad) normalized.Gravedad = 'Media';
        if (!normalized.Descripcion) normalized.Descripcion = 'Sin descripción detallada disponible.';
        
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

        const hasReport = state.filteredReports.find(r => normalizeName(r.Municipio) === normalized);
        const rawFeature = state.geojsonRaw ? state.geojsonRaw.features.find(f => normalizeName(f.properties.MPIO_NOMBR) === normalized) : null;
        const mpioName = rawFeature ? rawFeature.properties.MPIO_NOMBR : normalized;
        
        if (hasReport) {
            layer.setStyle({
                fillColor: getGravityColor(hasReport.Gravedad),
                fillOpacity: 0.15,
                color: getGravityColor(hasReport.Gravedad),
                weight: 1.5
            });
        } else {
            layer.setStyle({
                fillColor: '#161925',
                fillOpacity: 0.45,
                color: 'rgba(255, 255, 255, 0.08)',
                weight: 1
            });
        }

        // Restablecer el tooltip al modo hover básico
        layer.unbindTooltip();
        layer.bindTooltip(mpioName, {
            direction: 'auto',
            sticky: true,
            className: 'mpio-hover-tooltip'
        });
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
            dom.subregionFilter.value = 'all';
            state.activeFilters.subregion = 'all';
            state.activeFilters.gravity = 'all';
            state.activeFilters.search = '';
            state.activeFilters.damageType = 'all';
            state.activeFilters.redVialCategory = 'all';
            state.activeFilters.tipoRedVial = 'all';
            dom.searchInput.value = '';
            dom.clearSearchBtn.style.display = 'none';
            dom.gravityTags.forEach(tag => {
                tag.classList.toggle('active', tag.dataset.gravity === 'all');
            });
            
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
                normalizeName(report.Ubicacion || '').includes(normSearch);

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

    // Renderizar los marcadores de alerta en el centro geográfico de los municipios afectados
    function renderMarkers() {
        state.markersGroup.clearLayers();
        state.markerMap = {};

        state.filteredReports.forEach(report => {
            const normalized = normalizeName(report.Municipio);
            const layer = state.layerMap[normalized];
            
            if (layer) {
                // Obtener el centro del bounding box del polígono municipal
                const center = layer.getBounds().getCenter();
                const color = getGravityColor(report.Gravedad);
                const isVial = isVialType(report.Tipo_Afectacion);
                const redVialLabel = report.Red_Vial ? report.Red_Vial : 'VÍA';
                
                // HTML Personalizado para el círculo de alerta pulsante (con tipo de Red Vial y municipio)
                const markerHtml = `
                    <div class="pulse-marker-wrapper ${isVial ? 'priority-vial-marker' : ''}" style="--marker-color: ${color}">
                        <div class="pulse-ring"></div>
                        <div class="pulse-dot"></div>
                        ${isVial ? `<span class="vial-marker-indicator" title="Afectación en ${redVialLabel}">${redVialLabel}<br><span class="vial-marker-mpio">${report.Municipio}</span></span>` : ''}
                    </div>
                `;
                
                const customIcon = L.divIcon({
                    html: markerHtml,
                    className: `custom-pulse-icon ${isVial ? 'vial-custom-icon' : ''}`,
                    iconSize: [32, 32],
                    iconAnchor: [16, 16]
                });

                const marker = L.marker(center, { icon: customIcon });
                
                // Al hacer clic en el marcador, seleccionar el municipio
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

        if (state.filteredReports.length === 0) {
            dom.reportsList.innerHTML = `<div class="no-data">No se encontraron reportes con los filtros seleccionados.</div>`;
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
            { key: 'PRIMARIA', label: 'red vial primaria', icon: 'route', defaultColor: '#ef4444' },
            { key: 'SECUNDARIA', label: 'red vial secundaria', icon: 'git-merge', defaultColor: '#f97316' },
            { key: 'TERCIARIA', label: 'red vial terciaria', icon: 'trees', defaultColor: '#3b82f6' },
            { key: 'URBANA', label: 'red vial urbana', icon: 'building-2', defaultColor: '#10b981' }
        ];

        VIAL_CATEGORIES.forEach(cat => {
            const catReports = state.reports.filter(r => {
                const isVial = isVialType(r.Tipo_Afectacion) || !!r.Red_Vial;
                const rRedVial = normalizeName(r.Red_Vial || '');
                return isVial && rRedVial.includes(cat.key);
            });

            const count = catReports.length;
            const isActive = state.activeFilters.redVialCategory === cat.key;

            const highCount = catReports.filter(r => r.Gravedad === 'Alta').length;
            const lowCount = catReports.filter(r => r.Gravedad === 'Baja').length;
            let cardColor = cat.defaultColor;
            if (highCount > 0 && highCount >= catReports.length / 2) {
                cardColor = 'var(--accent-red)';
            } else if (lowCount > 0 && lowCount >= catReports.length / 2) {
                cardColor = 'var(--accent-blue)';
            }

            const card = document.createElement('div');
            card.className = `damage-type-card vial-category-card ${isActive ? 'active' : ''}`;

            if (isActive) {
                card.style.borderColor = cardColor;
                card.style.boxShadow = `0 0 14px ${cardColor}40`;
                card.style.background = `rgba(255, 255, 255, 0.08)`;
            }

            card.innerHTML = `
                <div class="damage-type-header">
                    <span class="damage-type-count">${count}</span>
                    <i data-lucide="${cat.icon}" class="damage-type-icon" style="color: ${cardColor}"></i>
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
       Interacciones y Selección de Municipio
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
        const report = state.reports.find(r => normalizeName(r.Municipio) === normalized);

        if (layer) {
            // Estilo seleccionado (glowing azul/blanco para indicar selección visual)
            layer.setStyle({
                fillColor: report ? getGravityColor(report.Gravedad) : '#3b82f6',
                fillOpacity: report ? 0.25 : 0.1,
                color: '#ffffff',
                weight: 2.5
            });
            layer.bringToFront();

            // Al seleccionar, ocultar el tooltip hover y NO mostrar tooltip permanente
            // (la info card flotante ya muestra toda la información)
            layer.unbindTooltip();

            if (flyTo) {
                // Volar al municipio seleccionado
                state.leafletMap.flyTo(layer.getBounds().getCenter(), 10, {
                    duration: 1.2
                });
            }
        }

        // Mostrar u ocultar la tarjeta de información flotante
        if (report) {
            dom.infoSubregion.innerText = report.Subregion;
            dom.infoMunicipality.innerText = report.Municipio;
            dom.infoType.innerText = report.Tipo_Afectacion;
            
            dom.infoGravity.innerText = report.Gravedad;
            dom.infoDesc.innerText = report.Descripcion;
            
            // Mostrar u ocultar filas para Red Vial y Ubicación
            if (dom.infoRedVialRow) {
                if (report.Red_Vial) {
                    dom.infoRedVialText.innerText = report.Red_Vial;
                    dom.infoRedVialRow.style.display = 'flex';
                } else {
                    dom.infoRedVialRow.style.display = 'none';
                }
            }

            if (dom.infoUbicacionRow) {
                if (report.Ubicacion) {
                    dom.infoUbicacionText.innerText = report.Ubicacion;
                    dom.infoUbicacionRow.style.display = 'flex';
                } else {
                    dom.infoUbicacionRow.style.display = 'none';
                }
            }
            
            // Estilo de la insignia de gravedad en la tarjeta
            dom.infoGravity.style.backgroundColor = `rgba(${getGravityRgb(report.Gravedad)}, 0.15)`;
            dom.infoGravity.style.color = getGravityColor(report.Gravedad);
            dom.infoGravity.style.border = `1px solid ${getGravityColor(report.Gravedad)}`;

            dom.infoCard.classList.remove('hidden');
        } else {
            if (dom.infoRedVialRow) dom.infoRedVialRow.style.display = 'none';
            if (dom.infoUbicacionRow) dom.infoUbicacionRow.style.display = 'none';
            // Municipio seleccionado no tiene reportes en el sismo
            const rawFeature = state.geojsonRaw.features.find(f => normalizeName(f.properties.MPIO_NOMBR) === normalized);
            const subregion = rawFeature ? rawFeature.properties.SUBREGION : 'Desconocida';
            const name = rawFeature ? rawFeature.properties.MPIO_NOMBR : normalized;
            
            dom.infoSubregion.innerText = subregion;
            dom.infoMunicipality.innerText = name;
            dom.infoType.innerText = 'Sin Afectaciones Reportadas';
            dom.infoGravity.innerText = 'Nula';
            dom.infoDesc.innerText = 'No se registran daños en infraestructura ni alertas de emergencia para este municipio.';

            dom.infoGravity.style.backgroundColor = 'rgba(255,255,255,0.05)';
            dom.infoGravity.style.color = 'var(--text-secondary)';
            dom.infoGravity.style.border = '1px solid var(--border-color)';
            
            dom.infoCard.classList.remove('hidden');
        }

        // Resaltar elemento correspondiente en el listado lateral
        const cards = dom.reportsList.querySelectorAll('.report-card');
        cards.forEach(card => {
            const cardTitle = card.querySelector('.card-title').innerText;
            if (normalizeName(cardTitle) === normalized) {
                card.classList.add('active');
                card.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
                // Scroll suave al elemento en la lista
                card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } else {
                card.classList.remove('active');
                card.style.backgroundColor = '';
            }
        });

        // En pantallas móviles, si se selecciona un municipio, cambiar automáticamente a la vista de mapa
        if (window.innerWidth <= 900 && state.showMapTab) {
            state.showMapTab();
        }
    }

    function deselectAll() {
        if (state.selectedMpio) {
            const oldMpio = state.selectedMpio;
            state.selectedMpio = null;
            resetLayerStyle(oldMpio);
        }
        dom.infoCard.classList.add('hidden');
        
        const cards = dom.reportsList.querySelectorAll('.report-card');
        cards.forEach(card => card.classList.remove('active'));
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
        // Buscador de texto
        dom.searchInput.addEventListener('input', (e) => {
            state.activeFilters.search = e.target.value;
            dom.clearSearchBtn.style.display = e.target.value ? 'block' : 'none';
            updateDashboard();
        });

        dom.clearSearchBtn.addEventListener('click', () => {
            dom.searchInput.value = '';
            state.activeFilters.search = '';
            dom.clearSearchBtn.style.display = 'none';
            updateDashboard();
        });

        // Dropdown de Subregión
        dom.subregionFilter.addEventListener('change', (e) => {
            state.activeFilters.subregion = e.target.value;
            updateDashboard();
        });

        // Botones de etiquetas de gravedad
        dom.gravityTags.forEach(tag => {
            tag.addEventListener('click', () => {
                dom.gravityTags.forEach(t => t.classList.remove('active'));
                tag.classList.add('active');
                
                state.activeFilters.gravity = tag.dataset.gravity;
                updateDashboard();
            });
        });
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

        // Clicar fuera de los municipios para deseleccionar
        state.leafletMap.on('click', () => {
            deselectAll();
        });
    }

    /* ==========================================================================
       Generación de Mapa Canvas y Reporte PDF (Infraestructura Vial)
       ========================================================================== */
    
    // Generar un gráfico tipo Canvas de la visión general de Antioquia con los puntos afectados
    function generateAntioquiaCanvasMap(vialReports) {
        if (!state.geojsonRaw || !state.geojsonRaw.features) {
            return null;
        }

        const canvas = document.createElement('canvas');
        canvas.width = 1200;
        canvas.height = 850;
        const ctx = canvas.getContext('2d');

        // Fondo oscuro ejecutivo premium
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Grid sutil decorativo en el fondo
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.lineWidth = 1;
        for (let x = 0; x < canvas.width; x += 40) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canvas.height);
            ctx.stroke();
        }
        for (let y = 0; y < canvas.height; y += 40) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
        }

        // Calcular la caja delimitadora (Bounding Box) de Antioquia
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

        if (minLng === Infinity) return null;

        // Parámetros de proyección
        const padding = 70;
        const width = canvas.width - padding * 2;
        const height = canvas.height - padding * 2;

        const lngSpan = maxLng - minLng;
        const latSpan = maxLat - minLat;

        const scale = Math.min(width / lngSpan, height / latSpan);
        const xOffset = padding + (width - lngSpan * scale) / 2;
        const yOffset = padding + (height - latSpan * scale) / 2;

        function project(lng, lat) {
            const x = xOffset + (lng - minLng) * scale;
            const y = yOffset + (maxLat - lat) * scale;
            return [x, y];
        }

        // Conjunto de nombres normalizados de municipios con afectación vial
        const affectedMpioMap = {};
        vialReports.forEach(r => {
            affectedMpioMap[normalizeName(r.Municipio)] = r;
        });

        // 1. Dibujar Polígonos de Municipios (todos igual, sin resaltar afectados)
        state.geojsonRaw.features.forEach(feature => {
            if (!feature.geometry) return;

            const polygons = feature.geometry.type === 'Polygon' 
                ? [feature.geometry.coordinates] 
                : feature.geometry.coordinates;

            polygons.forEach(polygon => {
                polygon.forEach(ring => {
                    if (ring.length === 0) return;
                    ctx.beginPath();
                    const [startX, startY] = project(ring[0][0], ring[0][1]);
                    ctx.moveTo(startX, startY);

                    for (let i = 1; i < ring.length; i++) {
                        const [x, y] = project(ring[i][0], ring[i][1]);
                        ctx.lineTo(x, y);
                    }
                    ctx.closePath();

                    // Todos los municipios con el mismo estilo neutro
                    ctx.fillStyle = 'rgba(30, 41, 59, 0.65)';
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
                    ctx.lineWidth = 0.7;
                    ctx.stroke();
                });
            });
        });

        // 2. Dibujar Puntos / Marcadores de Impacto en Municipios Afectados
        vialReports.forEach(report => {
            const normMpio = normalizeName(report.Municipio);
            const layer = state.layerMap[normMpio];
            let centerLng, centerLat;

            if (layer) {
                const center = layer.getBounds().getCenter();
                centerLng = center.lng;
                centerLat = center.lat;
            } else {
                const feature = state.geojsonRaw.features.find(f => normalizeName(f.properties.MPIO_NOMBR) === normMpio);
                if (feature) {
                    const pts = extractPoints(feature.geometry);
                    let sumX = 0, sumY = 0;
                    pts.forEach(([lng, lat]) => { sumX += lng; sumY += lat; });
                    centerLng = sumX / pts.length;
                    centerLat = sumY / pts.length;
                }
            }

            if (centerLng && centerLat) {
                const [x, y] = project(centerLng, centerLat);
                const color = getGravityColor(report.Gravedad);

                // Aura exterior translúcida
                ctx.beginPath();
                ctx.arc(x, y, 16, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${getGravityRgb(report.Gravedad)}, 0.25)`;
                ctx.fill();

                // Anillo de impacto
                ctx.beginPath();
                ctx.arc(x, y, 9, 0, Math.PI * 2);
                ctx.strokeStyle = color;
                ctx.lineWidth = 2.5;
                ctx.stroke();

                // Punto central brillante
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();

                // Etiqueta del municipio con fondo tipo pill
                const label = report.Municipio;
                ctx.font = 'bold 11px Outfit, Arial, sans-serif';
                const textMetrics = ctx.measureText(label);
                const textWidth = textMetrics.width;
                const pillPadding = 6;
                const pillX = x - textWidth / 2 - pillPadding;
                const pillY = y - 30;

                ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.beginPath();
                if (ctx.roundRect) {
                    ctx.roundRect(pillX, pillY, textWidth + pillPadding * 2, 18, 4);
                } else {
                    ctx.rect(pillX, pillY, textWidth + pillPadding * 2, 18);
                }
                ctx.fill();
                ctx.stroke();

                ctx.fillStyle = '#ffffff';
                ctx.fillText(label, pillX + pillPadding, pillY + 13);
            }
        });

        // 3. Encabezado en la Imagen Canvas
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(20, 20, 520, 50);
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.strokeRect(20, 20, 520, 50);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 14px Outfit, Arial, sans-serif';
        ctx.fillText('MAPA DE AFECTACIÓN DE INFRAESTRUCTURA VIAL', 35, 42);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px Outfit, Arial, sans-serif';
        ctx.fillText('DEPARTAMENTO DE ANTIOQUIA - MONITOR SISMOINFRA', 35, 58);

        // 4. Leyenda de la Imagen Canvas
        const legX = canvas.width - 260;
        const legY = canvas.height - 90;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(legX, legY, 240, 70);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.strokeRect(legX, legY, 240, 70);

        ctx.fillStyle = '#ef4444';
        ctx.beginPath(); ctx.arc(legX + 20, legY + 25, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.font = '11px Outfit, Arial, sans-serif';
        ctx.fillText('Municipio con Daño Vial', legX + 35, legY + 29);

        ctx.fillStyle = 'rgba(30, 41, 59, 0.9)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.fillRect(legX + 14, legY + 45, 12, 12);
        ctx.strokeRect(legX + 14, legY + 45, 12, 12);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('Límite Municipal Antioquia', legX + 35, legY + 55);

        return canvas.toDataURL('image/png');
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
        doc.text(`Fecha de emisión: ${dateStr} - ${timeStr} | Municipios afectados: ${vialReports.length}`, 14, 30);

        // --- SECCIÓN 1: MAPA GENERAL EN CANVAS ---
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(15, 23, 42);
        doc.text('1. Mapa General de Afectaciones Viales en Antioquia', 14, 46);

        // Generar mapa en Canvas y agregar la imagen al PDF
        const mapCanvasData = generateAntioquiaCanvasMap(vialReports);
        if (mapCanvasData) {
            doc.addImage(mapCanvasData, 'PNG', 14, 49, 182, 115);
        }

        // --- SECCIÓN 2: LISTADO DE AFECTACIONES VIALES ---
        const tableStartY = 172;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(15, 23, 42);
        doc.text('2. Listado Detallado de Afectaciones a la Red Vial', 14, tableStartY);

        const tableBody = vialReports.map((r, idx) => [
            (idx + 1).toString(),
            r.Municipio || '-',
            r.Subregion || '-',
            r.Red_Vial || '-',
            r.Tipo_Red_Vial || '-',
            r.Descripcion || 'Sin descripción disponible'
        ]);

        doc.autoTable({
            startY: tableStartY + 4,
            head: [['N°', 'Municipio', 'Subregión', 'Red Vial', 'Tipo elemento vial', 'Descripción del Impacto']],
            body: tableBody,
            theme: 'grid',
            headStyles: {
                fillColor: [239, 68, 68],
                textColor: [255, 255, 255],
                fontStyle: 'bold',
                fontSize: 8,
                halign: 'center'
            },
            bodyStyles: {
                fontSize: 7.5,
                cellPadding: 2.5,
                textColor: [30, 41, 59]
            },
            columnStyles: {
                0: { cellWidth: 8, halign: 'center' },
                1: { cellWidth: 28, fontStyle: 'bold' },
                2: { cellWidth: 25 },
                3: { cellWidth: 28 },
                4: { cellWidth: 28 },
                5: { cellWidth: 'auto' }
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
        const fileName = `Reporte_Infraestructura_Vial_Antioquia_${now.toISOString().slice(0,10)}.pdf`;
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
