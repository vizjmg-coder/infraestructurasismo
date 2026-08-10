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
            damageType: 'all' // Filtro dinámico por tarjeta de tipo de afectación
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
        infoDesc: document.getElementById('info-desc-text'),
        closeInfoCardBtn: document.getElementById('close-info-card-btn'),
        zoomToMpioBtn: document.getElementById('zoom-to-mpio-btn'),
        resetMapBtn: document.getElementById('reset-map-btn')
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
       Inicialización del Mapa (Leaflet)
       ========================================================================== */
    function initMap() {
        state.leafletMap = L.map('map', {
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

        // Reposicionar controles de zoom abajo a la derecha para no obstruir los paneles
        L.control.zoom({
            position: 'bottomright'
        }).addTo(state.leafletMap);

        // Grupo para los marcadores de alerta
        state.markersGroup = L.layerGroup().addTo(state.leafletMap);
    }

    /* ==========================================================================
       Carga Asíncrona de Municipios (GeoJSON con Barra de Progreso)
       ========================================================================== */
    async function loadGeoJson() {
        try {
            dom.loadingStatus.innerText = 'Buscando cobertura municipal...';
            
            // Usamos ReadableStream para poder rastrear el progreso de la descarga del GeoJSON (22.4 MB)
            const response = await fetch('Municipios.geojson');
            if (!response.ok) throw new Error('No se pudo cargar Municipios.geojson');
            
            const reader = response.body.getReader();
            
            // Si el servidor no envía Content-Length, aproximamos con el tamaño conocido (22.4MB)
            const contentLength = +response.headers.get('Content-Length') || 22420740;
            let receivedLength = 0;
            let chunks = [];
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                chunks.push(value);
                receivedLength += value.length;
                
                const percent = Math.min(Math.round((receivedLength / contentLength) * 100), 100);
                dom.progressBar.style.width = `${percent}%`;
                dom.loadingStatus.innerText = `Descargando mapa departamental: ${percent}%`;
            }
            
            dom.loadingStatus.innerText = 'Procesando coordenadas geográficas...';
            
            // Concatenar todos los chunks en un array único
            let chunksAll = new Uint8Array(receivedLength);
            let position = 0;
            for (let chunk of chunks) {
                chunksAll.set(chunk, position);
                position += chunk.length;
            }
            
            // Decodificar y parsear a JSON
            let decodedText = new TextDecoder("utf-8").decode(chunksAll);
            state.geojsonRaw = JSON.parse(decodedText);
            
            renderGeoJsonLayer();
            
            // Cargar y resaltar el borde completo del departamento de Antioquia
            await loadDepartmentOutline();
            
            // Finalizar carga e iniciar carga de datos por defecto
            dom.progressBar.style.width = '100%';
            setTimeout(() => {
                dom.loadingOverlay.classList.add('hidden');
                loadInitialMockData();
            }, 600);
            
        } catch (error) {
            console.error('Error cargando GeoJSON:', error);
            dom.loadingStatus.innerHTML = `<span style="color: var(--accent-red)">Error: No se pudo cargar el mapa. Asegúrate de que Municipios.geojson esté en la misma carpeta.</span>`;
            dom.progressBar.style.backgroundColor = 'var(--accent-red)';
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
            
            // Actualizar filtros
            dom.subregionFilter.value = 'all';
            state.activeFilters.subregion = 'all';
            state.activeFilters.gravity = 'all';
            state.activeFilters.search = '';
            state.activeFilters.damageType = 'all';
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
        
        // Restablecer estilos de todas las capas municipales según los filtros actuales
        Object.keys(state.layerMap).forEach(normalized => {
            if (state.selectedMpio !== normalized) {
                resetLayerStyle(normalized);
            }
        });
    }

    // Filtrar los datos en base a los inputs del usuario
    function applyFilters() {
        const { subregion, gravity, search, damageType } = state.activeFilters;
        
        state.filteredReports = state.reports.filter(report => {
            // Filtro por subregión
            const matchSubregion = subregion === 'all' || 
                normalizeName(report.Subregion) === normalizeName(subregion);
            
            // Filtro por gravedad
            const matchGravity = gravity === 'all' || 
                report.Gravedad === gravity;
                
            // Filtro por tipo de afectación (tarjetas interactivas)
            const matchDamageType = damageType === 'all' || 
                normalizeName(report.Tipo_Afectacion) === normalizeName(damageType);
                
            // Filtro por búsqueda de texto
            const normSearch = normalizeName(search);
            const matchSearch = !normSearch || 
                normalizeName(report.Municipio).includes(normSearch) || 
                normalizeName(report.Subregion).includes(normSearch) ||
                normalizeName(report.Tipo_Afectacion).includes(normSearch);

            return matchSubregion && matchGravity && matchDamageType && matchSearch;
        });
    }

    // Calcular y renderizar estadísticas en el panel lateral
    function calculateStatistics() {
        const uniqueAffected = new Set(state.filteredReports.map(r => normalizeName(r.Municipio)));
        if (dom.statAffectedCount) dom.statAffectedCount.innerText = uniqueAffected.size;

        // Contar afectaciones prioritarias de Infraestructura Vial
        const vialReports = state.filteredReports.filter(r => isVialType(r.Tipo_Afectacion));
        if (dom.statVialCount) dom.statVialCount.innerText = vialReports.length;

        // Gravedad Alta
        const highGravity = state.filteredReports.filter(r => r.Gravedad === 'Alta');
        if (dom.statHighGravity) dom.statHighGravity.innerText = highGravity.length;
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
                
                // HTML Personalizado para el círculo de alerta pulsante (con prioridad visual para vial)
                const markerHtml = `
                    <div class="pulse-marker-wrapper ${isVial ? 'priority-vial-marker' : ''}" style="--marker-color: ${color}">
                        <div class="pulse-ring"></div>
                        <div class="pulse-dot"></div>
                        ${isVial ? '<span class="vial-marker-indicator" title="Infraestructura Vial Prioritaria">⚡ VÍA</span>' : ''}
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
                    L.DomEvent.stopPropagation(e);
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
                        ${isVial ? '<span class="card-vial-badge">⚡ PRIORIDAD VIAL</span>' : ''}
                        <span class="card-badge">${report.Gravedad}</span>
                    </div>
                </div>
                <div class="card-subregion">${report.Subregion}</div>
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

    // Generar y renderizar las tarjetas dinámicas de tipo de afectación (INFRAESTRUCTURA VIAL PRIMERO)
    function renderDamageTypeCards() {
        dom.damageTypesGrid.innerHTML = '';
        
        // Obtener el conteo por Tipo_Afectacion a partir de TODOS los reportes cargados
        const counts = {};
        state.reports.forEach(report => {
            const type = report.Tipo_Afectacion;
            if (type) {
                counts[type] = (counts[type] || 0) + 1;
            }
        });

        const types = Object.keys(counts);

        if (types.length === 0) {
            dom.damageTypesGrid.innerHTML = '<div class="no-data">Sin afectaciones</div>';
            return;
        }

        // Ordenar categorías colocando INFRAESTRUCTURA VIAL en PRIMERA posición
        types.sort((a, b) => {
            const aIsVial = isVialType(a);
            const bIsVial = isVialType(b);
            if (aIsVial && !bIsVial) return -1;
            if (!aIsVial && bIsVial) return 1;
            return counts[b] - counts[a];
        });

        types.forEach(type => {
            const count = counts[type];
            const normalizedType = normalizeName(type);
            const isActive = state.activeFilters.damageType === normalizedType;
            const isVial = isVialType(type);

            // Mapear icono lucide representativo
            let iconName = 'alert-octagon';
            if (isVial) {
                iconName = 'milestone';
            } else if (normalizedType.includes('VIVIENDA') || normalizedType.includes('CASA') || normalizedType.includes('TECHO')) {
                iconName = 'home';
            } else if (normalizedType.includes('IGLESIA') || normalizedType.includes('TEMPLO') || normalizedType.includes('CATEDRAL')) {
                iconName = 'church';
            } else if (normalizedType.includes('SALUD') || normalizedType.includes('HOSPITAL') || normalizedType.includes('CLINICA')) {
                iconName = 'heart-pulse';
            } else if (normalizedType.includes('GRIETA') || normalizedType.includes('FACHADA') || normalizedType.includes('MURO')) {
                iconName = 'split';
            }

            // Establecer color de la tarjeta según la gravedad promedio
            const typeReports = state.reports.filter(r => normalizeName(r.Tipo_Afectacion) === normalizedType);
            const highCount = typeReports.filter(r => r.Gravedad === 'Alta').length;
            const lowCount = typeReports.filter(r => r.Gravedad === 'Baja').length;
            let cardColor = isVial ? '#f59e0b' : 'var(--accent-orange)'; // default Media Amber para viales
            
            if (highCount > typeReports.length / 2) {
                cardColor = 'var(--accent-red)';
            } else if (lowCount > typeReports.length / 2) {
                cardColor = 'var(--accent-blue)';
            }

            const card = document.createElement('div');
            card.className = `damage-type-card ${isActive ? 'active' : ''} ${isVial ? 'priority-vial-type-card' : ''}`;
            
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
                    ${isVial ? '<span class="type-priority-tag">PRIORITARIO</span>' : ''}
                </div>
            `;

            // Filtrar al hacer clic
            card.addEventListener('click', () => {
                if (isActive) {
                    state.activeFilters.damageType = 'all';
                } else {
                    state.activeFilters.damageType = normalizedType;
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

            // Intercambiar tooltip a permanente y centrado con el nombre resaltado
            const tooltipColor = report ? getGravityColor(report.Gravedad) : '#3b82f6';
            const rawFeature = state.geojsonRaw.features.find(f => normalizeName(f.properties.MPIO_NOMBR) === normalized);
            const mpioName = rawFeature ? rawFeature.properties.MPIO_NOMBR : normalized;
            const tooltipContent = `<div class="selected-tooltip-inner" style="border-color: ${tooltipColor}">${report ? report.Municipio : mpioName}</div>`;
            
            layer.unbindTooltip();
            layer.bindTooltip(tooltipContent, {
                permanent: true,
                direction: 'top',
                offset: [0, -15],
                className: 'selected-mpio-tooltip-wrapper'
            }).openTooltip();

            if (flyTo) {
                // Volar al municipio seleccionado
                state.leafletMap.flyTo(layer.getBounds().getCenter(), 10, {
                    duration: 1.2
                });
            }
        }

        // Mostrar u ocultar la tarjeta de información flotante
        if (report) {
            const isVial = isVialType(report.Tipo_Afectacion);
            dom.infoSubregion.innerText = report.Subregion;
            dom.infoMunicipality.innerText = report.Municipio;
            
            if (isVial) {
                dom.infoType.innerHTML = `${report.Tipo_Afectacion} <span class="info-vial-priority-tag">⚡ PRIORIDAD VIAL</span>`;
            } else {
                dom.infoType.innerText = report.Tipo_Afectacion;
            }
            
            dom.infoGravity.innerText = report.Gravedad;
            dom.infoDesc.innerText = report.Descripcion;
            
            // Estilo de la insignia de gravedad en la tarjeta
            dom.infoGravity.style.backgroundColor = `rgba(${getGravityRgb(report.Gravedad)}, 0.15)`;
            dom.infoGravity.style.color = getGravityColor(report.Gravedad);
            dom.infoGravity.style.border = `1px solid ${getGravityColor(report.Gravedad)}`;

            dom.infoCard.classList.remove('hidden');
        } else {
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
       Manejadores de Eventos del DOM y UI
       ========================================================================== */
    
    // Los manejadores de subida de archivos manuales han sido eliminados por solicitud del usuario,
    // dando prioridad a las tarjetas de filtrado de tipo de afectación y la carga automática desde Google Sheets.

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
            
            // Si hay municipios afectados, encuadrar sobre ellos. Si no, encuadrar el departamento completo.
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

        // Clicar fuera de los municipios para deseleccionar
        state.leafletMap.on('click', () => {
            deselectAll();
        });
    }

    /* ==========================================================================
       Inicialización de la Aplicación
       ========================================================================== */
    function init() {
        initMap();
        setupFilters();
        setupInteractions();
        
        // Cargar el GeoJSON (arranca la barra de progreso)
        loadGeoJson();
        
        // Inicializar iconos Lucide
        lucide.createIcons();
    }

    init();
});
