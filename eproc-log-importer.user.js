// ==UserScript==
// @name         Projeto LogsEproc
// @namespace    https://eproc1g.tjmg.jus.br
// @version      6.2
// @description  Extrai logs de todas as regras de automatizacao do EPROC + Dashboard BI
// @author       Allison de Castro Silva
// @updateURL    https://github.com/AllisondeCastro/Projeto-LogsEproc/raw/refs/heads/main/eproc-log-importer.user.js
// @downloadURL  https://github.com/AllisondeCastro/Projeto-LogsEproc/raw/refs/heads/main/eproc-log-importer.user.js
// @match        https://eproc1g.tjmg.jus.br/eproc/controlador.php?acao=automatizar_localizadores*
// @icon         https://eproc1g.tjmg.jus.br/imagens/icons/favicons/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // CONFIG
    // ================================================================
    var CONFIG = {
        supabaseUrl: GM_getValue('supabaseUrl', 'https://mijeghtxladzuaonwvtu.supabase.co'),
        supabaseKey: GM_getValue('supabaseKey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pamVnaHR4bGFkenVhb253dnR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDE3MTcsImV4cCI6MjA5NDg3NzcxN30.ISuiECykMFEvLUn4Hbw2uIIRAsaat8xCV1wK-GJg-9I'),
        batchSize: 10000,
        maxRegrasPorExecucao: GM_getValue('maxRules', 9999)
    };

    // ================================================================
    // SUPABASE REST CLIENT
    // ================================================================
    function supabaseRest(path, options) {
        options = options || {};
        return new Promise(function (resolve, reject) {
            var url = CONFIG.supabaseUrl + (path.charAt(0) === '/' ? '' : '/') + path;
            var headers = {
                'apikey': CONFIG.supabaseKey,
                'Authorization': 'Bearer ' + CONFIG.supabaseKey
            };
            if (options.data) headers['Content-Type'] = 'application/json';
            if (options.method === 'POST' && !options.noMerge) {
                headers['Prefer'] = 'resolution=merge-duplicates';
            }

            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: url,
                headers: headers,
                data: options.data ? JSON.stringify(options.data) : undefined,
                timeout: options.timeout || 120000,
                onload: function (resp) {
                    try {
                        var text = resp.responseText;
                        if (text === undefined || text === null || text.trim() === '') {
                            if (resp.status >= 400) {
                                reject(new Error('HTTP ' + resp.status));
                            } else {
                                resolve({});
                            }
                            return;
                        }
                        var obj = JSON.parse(text);
                        if (resp.status >= 400) {
                            reject(new Error(obj.message || obj.error || 'HTTP ' + resp.status));
                            return;
                        }
                        resolve(obj);
                    } catch (e) {
                        reject(new Error('Resposta invalida: ' + e.message));
                    }
                },
                onerror: function () { reject(new Error('Erro de rede')); },
                ontimeout: function () { reject(new Error('Timeout')); }
            });
        });
    }

    function supabaseGet(table, query) {
        var currentPerfil = (typeof PERFIL_ATUAL !== 'undefined') ? PERFIL_ATUAL : 'NUCIV 4.0';
        var perfilFilter = 'or=(perfil.eq.' + encodeURIComponent(currentPerfil) + ',perfil.is.null)';

        var q = query ? '?' + query + '&' + perfilFilter : '?' + perfilFilter;
        var all = [];
        var pageSize = 1000;
        var offset = 0;
        var maxRetries = 2;
        function fetchPage(tentativa) {
            tentativa = tentativa || 0;
            return supabaseRest('/rest/v1/' + table + q + (query ? '&' : '?') + 'limit=' + pageSize + '&offset=' + offset).then(function (data) {
                if (!data || !data.length) return all;
                all = all.concat(data);
                offset += data.length;
                if (data.length < pageSize) return all;
                return fetchPage();
            }, function (err) {
                if (tentativa < maxRetries) {
                    return new Promise(function (r) { setTimeout(r, 1000 * (tentativa + 1)); }).then(function () {
                        return fetchPage(tentativa + 1);
                    });
                }
                throw err;
            });
        }
        return fetchPage();
    }

    function supabasePost(table, rows) {
        return supabaseRest('/rest/v1/' + table, { method: 'POST', data: rows });
    }

    // ================================================================
    // DATA CONVERTERS (Supabase ↔ formato interno)
    // ================================================================
    function logsFromSupabase(rows) {
        if (!rows || !rows.length) return [];
        return rows.map(function (r) {
            var dataStr = '';
            if (r.data_only) {
                dataStr = fmtDataBR(r.data_only);
            } else if (r.data_completa) {
                var dc = String(r.data_completa).split(' ')[0];
                if (dc) dataStr = fmtDataBR(dc);
            }
            var horaStr = String(r.hora || '').trim();
            // Só mantém hora se estiver no formato HH:MM:SS (dados antigos corrompidos são ignorados)
            if (!/^\d{2}:\d{2}:\d{2}$/.test(horaStr)) horaStr = '';
            return [
                r.id || '',
                r.processo || '',
                dataStr,
                horaStr,
                r.regra || '',
                r.cod_regra || '',
                r.created_at || '',
                r.processo_url || ''
            ];
        });
    }

    function regrasFromSupabase(rows) {
        if (!rows || !rows.length) return [];
        return rows.map(function (r) {
            return [
                r.num_regra || '',
                r.grupo || '',
                r.origem || '',
                r.controle || '',
                r.destino || '',
                r.outros || ''
            ];
        });
    }

    function logsToSupabase(logs) {
        return logs.map(function (log) {
            var dataOnly = log.dataOnly || (log.data ? log.data.split(' ')[0] : '');
            return {
                id: log.id,
                processo: log.processo,
                processo_url: log.processoUrl || '',
                data_only: dataOnly.indexOf('/') !== -1
                    ? dataOnly.split('/')[2] + '-' + dataOnly.split('/')[1] + '-' + dataOnly.split('/')[0]
                    : dataOnly,
                hora: log.hora || '',
                data_completa: log.data || '',
                regra: log.regra,
                cod_regra: log.codRegra || '',
                perfil: (typeof PERFIL_ATUAL !== 'undefined') ? PERFIL_ATUAL : 'NUCIV 4.0'
            };
        });
    }

    function regrasToSupabase(list) {
        return list.map(function (r) {
            return {
                num_regra: r.numRegra,
                grupo: r.grupo || 'Não Classificado',
                origem: r.origem || '',
                controle: r.controle || '',
                destino: r.destino || '',
                outros: r.outros || '',
                perfil: (typeof PERFIL_ATUAL !== 'undefined') ? PERFIL_ATUAL : 'NUCIV 4.0'
            };
        });
    }

    // Detecção de Perfil
    function detectarPerfilUsuario() {
        try {
            var sel = document.getElementById('selLotacao') || document.querySelector('select[name="selLotacao"]');
            if (sel && sel.selectedIndex >= 0) {
                var opt = sel.options[sel.selectedIndex];
                if (opt && opt.text) return opt.text.split('/')[0].trim();
            }
            var optSel = document.querySelector('option[selected="selected"]');
            if (optSel && optSel.text) {
                var txt = optSel.text;
                if (txt.indexOf('/') !== -1) return txt.split('/')[0].trim();
                return txt.trim();
            }
        } catch (e) { }
        return null;
    }

    var PERFIL_ATUAL = detectarPerfilUsuario();

    // Early fetch - busca dados do Supabase imediatamente (paralelo ao resto)
    var _earlyDadosPromise = null;
    if (CONFIG.supabaseUrl && CONFIG.supabaseKey) {
        _earlyDadosPromise = Promise.all([
            supabaseGet('logs', 'select=*'),
            supabaseGet('regras', 'select=*')
        ]).then(function (results) {
            return {
                logs: logsFromSupabase(results[0]),
                regras: regrasFromSupabase(results[1])
            };
        }).catch(function () {
            return null;
        });
    }

    // ================================================================
    // STATE
    // ================================================================
    var state = {
        perfilAtual: PERFIL_ATUAL,
        viewMode: 'minimized',
        compactMode: true,
        darkMode: String(GM_getValue('darkMode', 'false')) === 'true',
        tabAtiva: 'extracao',
        processando: false,
        pausado: false,
        arrastando: false,
        arrastoOffX: 0,
        arrastoOffY: 0,
        resumeResolver: null,
        idsEnviados: new Set(),
        idsExistentesPlanilha: new Set(),
        logsBuffer: [],
        stats: {
            regrasTotal: 0, regrasProcessadas: 0,
            logsExtraidos: 0, logsNovos: 0, logsIgnorados: 0, logsDuplicados: 0, erros: 0, errosFetch: 0, errosFlush: 0,
            inicio: 0, temposRegra: [], porRegra: {}
        },
        regrasPendentes: [],
        ultimaExtracao: PERFIL_ATUAL ? GM_getValue('ultimaExtracao_' + PERFIL_ATUAL, null) : null,
        retryBatch: { contador: 0, dados: null },
        // Dashboard state
        dadosBrutos: null,
        dadosFiltrados: null,
        regrasMap: null,
        chartInstances: {},
        filters: {
            dataInicio: null,
            dataFim: null,
            grupo: 'todos',
            regra: 'todas',
            processo: '',
            ordenacao: 'frequencia-desc',
            pieDimensao: 'data'
        },
        exibirProcessos: true,
        tabelaSort: 'regra',
        tabelaSortDir: 'regra',
        tabelaSortDirAsc: true,
        metricaAtiva: 'execucoes',
        silentMode: false
    };

    // ================================================================
    // UTILITIES
    // ================================================================
    function agora() {
        var d = new Date();
        return ('0' + d.getHours()).slice(-2) + ':' +
            ('0' + d.getMinutes()).slice(-2) + ':' +
            ('0' + d.getSeconds()).slice(-2);
    }

    function fmtTempo(ms) {
        var s = Math.floor(ms / 1000);
        return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }

    function fmtNumero(n) {
        if (!n && n !== 0) return '0';
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }

    function fmtDataISO(d) {
        if (!d) return '';
        if (typeof d === 'string' && d.indexOf('T') !== -1) {
            var dt = new Date(d);
            if (!isNaN(dt)) d = dt;
        }
        if (typeof d === 'string') {
            var str = d.split(' ')[0];
            var partes = str.split('/');
            if (partes.length === 3) return partes[2] + '-' + partes[1] + '-' + partes[0];
            return str;
        }
        if (d instanceof Date && !isNaN(d)) {
            return d.getFullYear() + '-' +
                ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
                ('0' + d.getDate()).slice(-2);
        }
        return String(d);
    }

    function fmtDataBR(d) {
        if (!d) return '';
        if (typeof d === 'string' && d.indexOf('T') !== -1) {
            var dt = new Date(d);
            if (!isNaN(dt)) d = dt;
        }
        if (typeof d === 'string' && d.indexOf('/') !== -1) return d.split(' ')[0];
        if (typeof d === 'string' && d.indexOf('-') !== -1) {
            var partes = d.split(' ')[0].split('-');
            if (partes.length === 3) return partes[2] + '/' + partes[1] + '/' + partes[0];
            return d;
        }
        if (d instanceof Date && !isNaN(d)) {
            return ('0' + d.getDate()).slice(-2) + '/' +
                ('0' + (d.getMonth() + 1)).slice(-2) + '/' +
                d.getFullYear();
        }
        return String(d);
    }

    function fmtHoraBR(h) {
        if (!h) return '';
        var str = String(h).trim();
        // Tenta extrair HH:MM:SS de qualquer formato usando regex antes de qualquer manipulação
        var rawMatch = str.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
        if (rawMatch) {
            var hh = rawMatch[1];
            var mm = rawMatch[2];
            var ss = rawMatch[3] || '00';
            return hh + ':' + mm + ':' + ss;
        }
        return '';
    }

    function hojeISO() {
        var d = new Date();
        return d.getFullYear() + '-' +
            ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
            ('0' + d.getDate()).slice(-2);
    }

    function escHTML(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function adicionarLog(msg, tipo) {
        var list = document.getElementById('eproc-log-list');
        if (!list) {
            if (typeof console !== 'undefined' && console.log) console.log('§ LOG: [' + agora() + '] ' + msg);
            return;
        }
        var div = document.createElement('div');
        div.className = 'log-entry' + (tipo ? ' ' + tipo : '');
        div.textContent = '[' + agora() + '] ' + msg;
        list.insertBefore(div, list.firstChild);
        while (list.children.length > 200) list.removeChild(list.lastChild);
    }

    function beep() {
        if (state.silentMode) return;
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 880;
            gain.gain.value = 0.15;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
            osc.stop(ctx.currentTime + 0.25);
            setTimeout(function () { ctx.close(); }, 300);
        } catch (e) { }
    }

    async function md5(str) {
        var buf = new TextEncoder().encode(str);
        var hash = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hash)).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }

    // ================================================================
    // CDN LOADER
    // ================================================================
    function carregarCDN(url) {
        return new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = url;
            script.onload = resolve;
            script.onerror = function () {
                adicionarLog('Erro ao carregar CDN: ' + url, 'error');
                reject(new Error('Falha CDN: ' + url));
            };
            document.head.appendChild(script);
        });
    }

    var cdnCarregados = { chartjs: false, sheetjs: false };
    var cdnPromises = { chartjs: null, sheetjs: null };

    function carregarChartJS() {
        if (cdnCarregados.chartjs) return Promise.resolve();
        if (cdnPromises.chartjs) return cdnPromises.chartjs;
        cdnPromises.chartjs = carregarCDN('https://cdn.jsdelivr.net/npm/chart.js').then(function () {
            cdnCarregados.chartjs = true;
            adicionarLog('Chart.js carregado', 'info');
        });
        return cdnPromises.chartjs;
    }

    function carregarSheetJS() {
        if (cdnCarregados.sheetjs) return Promise.resolve();
        if (cdnPromises.sheetjs) return cdnPromises.sheetjs;
        cdnPromises.sheetjs = carregarCDN('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js').then(function () {
            cdnCarregados.sheetjs = true;
            adicionarLog('SheetJS carregado', 'info');
        });
        return cdnPromises.sheetjs;
    }

    // ================================================================
    // CSS
    // ================================================================
    var CSS = [
        '@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");',

        /* Mini Button */
        '#eproc-mini-btn { position:fixed; top:24px; right:24px; width:52px; height:52px; z-index:999999;',
        '  border-radius:50%; cursor:pointer; display:flex; align-items:center; justify-content:center;',
        '  background:linear-gradient(135deg,#1f6feb,#58a6ff); border:1px solid rgba(255,255,255,0.1);',
        '  box-shadow:0 4px 20px rgba(31,111,235,0.4), inset 0 1px 0 rgba(255,255,255,0.15);',
        '  transition:transform 0.3s ease, box-shadow 0.3s ease; }',
        '#eproc-mini-btn:hover { transform:scale(1.1); box-shadow:0 6px 28px rgba(31,111,235,0.55); }',
        '#eproc-mini-btn svg { width:24px; height:24px; stroke:#fff; fill:none; stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; }',

        /* Dashboard Container */
        '#eproc-dashboard { position:fixed; z-index:999998; font-family:"Inter",-apple-system,sans-serif;',
        '  background:#161b22; border:1px solid #30363d; border-radius:12px;',
        '  box-shadow:0 8px 32px rgba(0,0,0,0.5); overflow:hidden; user-select:none;',
        '  transition:width 0.3s ease, height 0.3s ease, left 0.3s ease, top 0.3s ease, opacity 0.3s ease;',
        '  display:none; }',
        '#eproc-dashboard.compact { width:540px; right:16px; top:16px; left:auto !important; bottom:auto !important; }',
        '#eproc-dashboard.maximized { width:100vw; height:100vh; left:0; top:0; right:0; bottom:0; border-radius:0; border:none; display:flex; flex-direction:column; }',
        '#eproc-dashboard.maximized .tab-content.active { display:flex; flex-direction:column; flex:1; overflow:hidden; }',
        '#eproc-dashboard.maximized .chart-box .ch-body { min-height: 320px; max-height: 500px; }',
        '#eproc-dashboard.show { display:block; }',
        '#eproc-dashboard.show.maximized { display:flex; }',

        /* Header */
        '#eproc-dashboard .dash-header { padding:12px 16px; display:flex; justify-content:space-between;',
        '  align-items:center; border-bottom:1px solid #21262d; background:#0d1117; cursor:grab; }',
        '#eproc-dashboard .dash-header:active { cursor:grabbing; }',
        '#eproc-dashboard .dash-header .htitle { display:flex; align-items:center; gap:8px;',
        '  font-weight:600; font-size:13px; color:#e6edf3; }',
        '#eproc-dashboard .dash-header .htitle .hicon { width:26px; height:26px;',
        '  background:linear-gradient(135deg,#1f6feb,#58a6ff); border-radius:6px;',
        '  display:flex; align-items:center; justify-content:center; font-size:13px; color:#fff; flex-shrink:0; }',
        '#eproc-dashboard .dash-header .hstatus { font-size:9px; color:#8b949e; display:flex; align-items:center; gap:4px; }',
        '#eproc-dashboard .dash-header .hstatus .dot { width:6px; height:6px; border-radius:50%; display:inline-block; }',
        '#eproc-dashboard .dash-header .hactions { display:flex; gap:6px; align-items:center; }',
        '#eproc-dashboard .dash-header .hactions button { background:transparent; border:none;',
        '  color:#8b949e; cursor:pointer; font-size:14px; padding:4px; border-radius:4px;',
        '  transition:all 0.15s; line-height:1; display:flex; align-items:center; justify-content:center; }',
        '#eproc-dashboard .dash-header .hactions button:hover { color:#e6edf3; background:#21262d; }',
        '#eproc-btn-viewmode { display:flex; align-items:center; justify-content:center; width:22px; height:22px; }',
        '#eproc-btn-viewmode .viewmode-icon { display:block; width:10px; height:10px; border:1.5px solid currentColor; border-radius:1.5px; position:relative; box-sizing:border-box; transition:all 0.25s ease; }',
        '#eproc-dashboard.maximized #eproc-btn-viewmode .viewmode-icon { width:8px; height:8px; border:1.2px solid currentColor; border-radius:1px; transform:translate(-1px, 1px); }',
        '#eproc-dashboard.maximized #eproc-btn-viewmode .viewmode-icon::after { content:""; position:absolute; width:8px; height:8px; border:1.2px solid currentColor; border-radius:1px; left:2px; top:-3px; border-bottom:none; border-left:none; box-sizing:border-box; }',

        /* Tabs (Google Chrome Style) */
        '#eproc-dashboard .tab-bar { display:flex; align-items:flex-end; background:#161b22; padding:6px 12px 0 12px;',
        '  border-bottom:1px solid #30363d; gap:2px; height:34px; }',
        '#eproc-dashboard.light-mode .tab-bar { background:#eaeef2; border-bottom-color:#d8dee4; }',
        '#eproc-dashboard .tab-bar .tab-btn { padding:6px 16px; background:transparent; border:1px solid transparent;',
        '  border-bottom:none; border-radius:8px 8px 0 0; color:#8b949e; font-size:11px; font-weight:500; cursor:pointer;',
        '  font-family:inherit; transition:all 0.15s; display:flex; align-items:center; gap:6px; white-space:nowrap;',
        '  margin-bottom:-1px; height:28px; position:relative; }',
        '#eproc-dashboard .tab-bar .tab-btn:hover { background:rgba(255,255,255,0.05); color:#e6edf3; }',
        '#eproc-dashboard.light-mode .tab-bar .tab-btn:hover { background:rgba(0,0,0,0.04); color:#1f2328; }',
        '#eproc-dashboard .tab-bar .tab-btn.active { background:#0d1117; color:#58a6ff; border-color:#30363d;',
        '  font-weight:600; z-index:2; }',
        '#eproc-dashboard.light-mode .tab-bar .tab-btn.active { background:#ffffff; color:#0969da; border-color:#d8dee4; }',
        '#eproc-dashboard .tab-bar .tab-btn .tbadge { font-size:8px; padding:1px 5px; border-radius:8px;',
        '  background:#30363d; color:#8b949e; }',
        '#eproc-dashboard .tab-bar .tab-btn.active .tbadge { background:#1f6feb33; color:#58a6ff; }',
        '#eproc-dashboard.light-mode .tab-bar .tab-btn .tbadge { background:#eaeef2; color:#6e7681; }',
        '#eproc-dashboard.light-mode .tab-bar .tab-btn.active .tbadge { background:#ddf4ff; color:#0969da; }',
        '#eproc-dashboard .tab-refresh-btn { transition: all 0.2s ease; margin-bottom: 4px; }',
        '#eproc-dashboard .tab-refresh-btn:hover { transform: rotate(180deg); color: #58a6ff !important; }',
        '#eproc-dashboard .tab-bar .tab-btn .status-badge { font-size:8px; padding:1px 6px; border-radius:8px; font-weight:600; }',
        '#eproc-dashboard .tab-bar .tab-btn .status-badge.ativos { background:#3fb95022; color:#3fb950; }',
        '#eproc-dashboard .tab-bar .tab-btn .status-badge.desatualizado { background:#d2992222; color:#d29922; }',

        /* Tab Content */
        '#eproc-dashboard .tab-content { display:none; animation:fadeTab 0.25s ease; padding-bottom:40px; }',
        '#eproc-dashboard .tab-content.active { display:block; }',
        '@keyframes fadeTab { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }',

        /* Tab 1 - Extracao (existing style, modernized) */
        '#eproc-dashboard .ext-body { padding:10px 12px; }',
        '#eproc-dashboard .stats-box { border:1px solid #21262d; border-radius:8px;',
        '  background:#0d1117; margin-bottom:8px; overflow:hidden; }',
        '#eproc-dashboard .stats-box table { width:100%; border-collapse:collapse; }',
        '#eproc-dashboard .stats-box td { padding:4px 10px; border-bottom:1px solid #21262d; font-size:11px; }',
        '#eproc-dashboard .stats-box tr:last-child td { border-bottom:none; }',
        '#eproc-dashboard .stats-box td.label { color:#8b949e; }',
        '#eproc-dashboard .stats-box td.value { text-align:right; font-weight:600; color:#e6edf3; }',
        '#eproc-dashboard .stats-box tr:hover td { background:#161b22; cursor:pointer; }',

        '#eproc-dashboard .tooltip-box { display:none; position:absolute; top:100%; left:0; right:0;',
        '  background:#161b22; border:1px solid #30363d; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,.3);',
        '  z-index:10; max-height:200px; overflow-y:auto; font-size:10px; margin-top:2px; }',
        '#eproc-dashboard .tooltip-box .tt-row { padding:3px 10px; border-bottom:1px solid #21262d;',
        '  display:flex; justify-content:space-between; color:#8b949e; }',
        '#eproc-dashboard .tooltip-box .tt-row:last-child { border-bottom:none; }',
        '#eproc-dashboard .tooltip-box .tt-value { font-weight:600; color:#e6edf3; }',

        '#eproc-dashboard .bar-bg { height:6px; background:#21262d; border-radius:3px; margin:6px 0; overflow:hidden; }',
        '#eproc-dashboard .bar-fill { height:100%; background:linear-gradient(90deg,#1f6feb,#58a6ff);',
        '  border-radius:3px; width:0%; transition:width 0.3s ease; }',

        '#eproc-dashboard .log-area { border:1px solid #21262d; border-radius:6px;',
        '  background:#0d1117; max-height:180px; overflow-y:auto; margin-top:6px; }',
        '#eproc-dashboard .log-entry { font-family:"JetBrains Mono",Consolas,monospace; font-size:10px;',
        '  color:#8b949e; padding:3px 8px; border-bottom:1px solid #21262d; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
        '#eproc-dashboard .log-entry:last-child { border-bottom:none; }',
        '#eproc-dashboard .log-entry:hover { overflow:visible; white-space:normal; word-break:break-all; background:#161b22; }',

        '#eproc-dashboard .ext-footer { padding:6px 12px 8px; display:flex; gap:4px; flex-wrap:wrap; border-top:1px solid #21262d; }',
        '#eproc-dashboard .ext-footer button { font-family:inherit; font-size:11px; padding:4px 10px;',
        '  border:1px solid #30363d; border-radius:6px; background:#0d1117; color:#8b949e; cursor:pointer; transition:all 0.15s; }',
        '#eproc-dashboard .ext-footer button:hover { background:#21262d; border-color:#484f58; color:#e6edf3; }',
        '#eproc-dashboard .ext-footer button.primary { color:#58a6ff; border-color:#1f6feb; }',
        '#eproc-dashboard .ext-footer button.primary:hover { background:#1f6feb33; }',
        '#eproc-dashboard .ext-footer button.success { color:#3fb950; border-color:#3fb95033; }',
        '#eproc-dashboard .ext-footer button.success:hover { background:#3fb95022; }',
        '#eproc-dashboard .ext-footer button.danger { color:#f85149; border-color:#f8514933; }',
        '#eproc-dashboard .ext-footer button.danger:hover { background:#f8514922; }',

        '#eproc-dashboard .warn { color:#d29922; }',
        '#eproc-dashboard .success { color:#3fb950; }',
        '#eproc-dashboard .error { color:#f85149; }',
        '#eproc-dashboard .info { color:#58a6ff; }',
        '#eproc-dashboard .icon-invertible { filter: invert(1); }',
        '#eproc-dashboard.light-mode .icon-invertible { filter: none; }',

        '#eproc-dashboard .pausado-badge { display:inline-block; background:#d29922; color:#0d1117; font-size:9px; padding:1px 6px; border-radius:3px; font-weight:700; margin-left:6px; animation:pulse-bg 1.5s infinite; }',
        '@keyframes pulse-bg { 0%{opacity:1} 50%{opacity:.5} 100%{opacity:1} }',

        /* Tab 2 - Relatórios (Dashboard) */
        '#eproc-dashboard .rel-body { padding:12px; flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:12px; }',
        '#eproc-dashboard.compact .rel-body { max-height:70vh; display:block; }',
        '#eproc-dashboard .dash-grid { flex:1; display:grid; grid-template-columns:210px 1fr; gap:12px; }',
        '#eproc-dashboard .rel-body::-webkit-scrollbar { width:6px; }',
        '#eproc-dashboard .rel-body::-webkit-scrollbar-track { background:transparent; }',
        '#eproc-dashboard .rel-body::-webkit-scrollbar-thumb { background:#30363d; border-radius:3px; }',

        /* Loading */
        '#eproc-dashboard .rel-loading { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:60px 20px; color:#8b949e; }',
        '#eproc-dashboard .rel-loading .spinner { width:32px; height:32px; border:3px solid #21262d; border-top-color:#58a6ff; border-radius:50%; animation:spin 0.8s linear infinite; margin-bottom:12px; }',
        '@keyframes spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }',
        '#eproc-dashboard .rel-loading .spinner-text { font-size:12px; }',

        /* Error/Empty */
        '#eproc-dashboard .rel-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:50px 20px; color:#8b949e; text-align:center; }',
        '#eproc-dashboard .rel-empty .e-icon { font-size:36px; margin-bottom:10px; opacity:0.5; }',
        '#eproc-dashboard .rel-empty .e-text { font-size:13px; margin-bottom:6px; }',
        '#eproc-dashboard .rel-empty .e-sub { font-size:11px; color:#484f58; }',
        '#eproc-dashboard .rel-empty button { margin-top:12px; padding:6px 16px; background:#1f6feb; color:#fff; border:none; border-radius:6px; font-size:11px; cursor:pointer; font-family:inherit; }',

        /* Loading */
        '@media (max-width:700px) { #eproc-dashboard .dash-grid { grid-template-columns:1fr; } }',

        /* Sidebar Filters */
        '#eproc-dashboard .filter-sidebar { background:#0d1117; border:1px solid #21262d; border-radius:8px; padding:12px; }',
        '#eproc-dashboard .filter-sidebar .fs-title { text-align:center; font-size:9px; text-transform:uppercase; letter-spacing:0.6px; color:#8b949e; font-weight:600; margin-bottom:8px; }',
        '#eproc-dashboard .filter-sidebar .fs-label { font-size:10px; color:#8b949e; margin-bottom:2px; font-weight:500; }',
        '#eproc-dashboard .filter-sidebar .fs-field { width:100%; padding:5px 8px; background:#161b22; border:1px solid #30363d; border-radius:6px; font-size:11px; color:#e6edf3; margin-bottom:6px; font-family:inherit; }',
        '#eproc-dashboard .filter-sidebar .fs-field:focus { outline:none; border-color:#1f6feb; box-shadow:0 0 0 2px rgba(31,111,235,.12); }',
        '#eproc-dashboard .filter-sidebar .fs-row { display:flex; justify-content:space-between; gap:4px; margin-bottom:6px; }',
        '#eproc-dashboard .filter-sidebar .fs-row .fs-field { margin-bottom:0; flex:1; padding:3px 4px; font-size:9px; height:24px; }',
        '#eproc-dashboard .filter-sidebar .fs-presets { display:flex; gap:3px; margin-bottom:8px; flex-wrap:wrap; }',
        '#eproc-dashboard .filter-sidebar .fs-presets span { padding:2px 7px; background:#21262d; border-radius:4px; font-size:9px; color:#8b949e; cursor:pointer; transition:all 0.15s; }',
        '#eproc-dashboard .filter-sidebar .fs-presets span:hover { background:#30363d; color:#e6edf3; }',
        '#eproc-dashboard .filter-sidebar .fs-presets span.active { background:#1f6feb33; color:#58a6ff; font-weight:600; border:1px solid #1f6feb44; }',
        '#eproc-dashboard .filter-sidebar .fs-btn { width:100%; padding:6px; border:none; border-radius:6px; font-weight:600; font-size:10px; cursor:pointer; font-family:inherit; transition:all 0.15s; margin-bottom:4px; }',
        '#eproc-dashboard .filter-sidebar .fs-btn.primary { background:#1f6feb; color:#fff; }',
        '#eproc-dashboard .filter-sidebar .fs-btn.primary:hover { background:#388bfd; }',
        '#eproc-dashboard .filter-sidebar .fs-btn.secondary { background:#21262d; color:#8b949e; }',
        '#eproc-dashboard .filter-sidebar .fs-btn.secondary:hover { background:#30363d; color:#e6edf3; }',
        '#eproc-dashboard .filter-sidebar .fs-divider { border:none; border-top:1px solid #21262d; margin:8px 0; }',
        '#eproc-dashboard .filter-sidebar .fs-ord-toggle { display:flex; gap:3px; margin-bottom:6px; }',
        '#eproc-dashboard .filter-sidebar .fs-ord-toggle span { flex:1; text-align:center; padding:5px; border-radius:5px; font-size:9px; cursor:pointer; transition:all 0.15s; background:#21262d; color:#8b949e; }',
        '#eproc-dashboard .filter-sidebar .fs-ord-toggle span.active { background:#1f6feb33; color:#58a6ff; font-weight:600; }',
        '#eproc-dashboard .rg-paral { margin-top:12px; background:#161b22; border:1px solid #30363d; border-radius:6px; padding:8px; }',
        '#eproc-dashboard .rg-paral-title { display:flex; justify-content:center; align-items:center; gap:6px; font-size:10px; font-weight:600; color:#e6edf3; margin-bottom:6px; }',
        '#eproc-dashboard .rg-paral-badge { background:#f8514933; color:#f85149; padding:1px 6px; border-radius:8px; font-size:9px; }',
        '#eproc-dashboard .rg-paral-list { display:flex; flex-direction:column; gap:6px; max-height:300px; overflow-y:auto; }',
        '#eproc-dashboard .rg-paral-list::-webkit-scrollbar { width:4px; }',
        '#eproc-dashboard .rg-paral-list::-webkit-scrollbar-thumb { background:#30363d; border-radius:2px; }',
        '#eproc-dashboard .rg-paral-item { display:flex; justify-content:space-between; font-size:9px; padding:4px 0; }',
        '#eproc-dashboard .rg-paral-item:nth-child(even) { background:#1c2333; border-radius:4px; }',
        '#eproc-dashboard .rg-paral-left { display:flex; flex-direction:column; gap:2px; color:#c9d1d9; font-weight:500; }',
        '#eproc-dashboard .rg-paral-left span { color:#8b949e; font-size:8px; font-weight:400; }',
        '#eproc-dashboard .rg-paral-right { color:#8b949e; font-weight:600; }',
        '#eproc-dashboard .rg-paral-ultima { display:block; font-size:8px; color:#8b949e; font-weight:400; margin-top:1px; }',

        /* Glossary */
        '#eproc-dashboard .glossary-box { margin-top:4px; background:#161b22; border:1px solid #30363d; border-radius:6px; padding:8px; font-size:10px; max-height:600px; overflow-y:auto; }',
        '#eproc-dashboard .glossary-box::-webkit-scrollbar { width:4px; }',
        '#eproc-dashboard .glossary-box::-webkit-scrollbar-thumb { background:#30363d; border-radius:2px; }',
        '#eproc-dashboard .glossary-box .g-title { font-weight:600; color:#58a6ff; margin-bottom:3px; }',
        '#eproc-dashboard .glossary-box .g-row { color:#e6edf3; line-height:1.5; display:flex; gap:4px; }',
        '#eproc-dashboard .glossary-box .g-row .g-label { color:#c9d1d9; font-weight:600; white-space:nowrap; }',
        '#eproc-dashboard .glossary-box .g-row .g-value { word-break:break-word; }',

        /* Main content (right side) */
        '#eproc-dashboard .dash-main { display:flex; flex-direction:column; gap:8px; }',

        /* Summary */
        '#eproc-dashboard .dash-summary { background:#0d1117; border:1px solid #21262d; border-radius:8px; padding:7px 10px; font-size:10px; color:#8b949e; line-height:1.4; }',
        '#eproc-dashboard .dash-summary strong { color:#e6edf3; }',

        /* KPIs */
        '#eproc-dashboard .kpi-row { display:flex; gap:8px; width:100%; margin-bottom:4px; }',
        '#eproc-dashboard .kpi-card { flex:1; background:#161b22; border:1px solid #30363d; border-radius:8px; padding:12px; text-align:left; display:flex; flex-direction:column; position:relative; overflow:hidden; }',
        '#eproc-dashboard .kpi-card-exec::before { content:""; position:absolute; top:0; right:0; bottom:0; left:50%; background:linear-gradient(90deg, transparent, rgba(210, 153, 34, 0.15)); pointer-events:none; }',
        '#eproc-dashboard .kpi-card-proc::before { content:""; position:absolute; top:0; right:0; bottom:0; left:50%; background:linear-gradient(90deg, transparent, rgba(88, 166, 255, 0.15)); pointer-events:none; }',
        '#eproc-dashboard .kpi-card .kpi-num { font-size:24px; font-weight:700; color:#fff; z-index:1; }',
        '#eproc-dashboard .kpi-card .kpi-label { font-size:11px; font-weight:600; color:#c9d1d9; margin-top:4px; z-index:1; }',
        '#eproc-dashboard .kpi-card .kpi-top { display:flex; justify-content:space-between; align-items:flex-start; }',
        '#eproc-dashboard .kpi-card .kpi-delta { font-size:10px; font-weight:500; color:#8b949e; display:flex; flex-direction:column; align-items:flex-end; gap:2px; flex-shrink:0; padding-top:2px; z-index:1; }',
        '#eproc-dashboard .rel-top-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid #21262d; }',
        '#eproc-dashboard .rel-top-bar .rt-title { font-size:12px; font-weight:600; color:#e6edf3; }',
        '#eproc-dashboard .rel-top-bar button { font-family:inherit; font-size:11px; padding:4px 10px; border:1px solid #1f6feb; border-radius:6px; background:#1f6feb22; color:#58a6ff; cursor:pointer; transition:all 0.15s; }',
        '#eproc-dashboard .rel-top-bar button:hover { background:#1f6feb44; color:#fff; }',
        '#eproc-dashboard .btn-sober-gold { position:relative; background:transparent; color:#c9d1d9; font-family:inherit; font-size:11px; padding:4px 12px; border:none; border-radius:6px; cursor:pointer; transition:all 0.25s ease; z-index:1; display:flex; align-items:center; justify-content:center; gap:4px; text-decoration:none; white-space:nowrap; }',
        '#eproc-dashboard .btn-sober-gold::before { content:""; position:absolute; inset:0; border-radius:6px; padding:0.5px; background:linear-gradient(90deg, rgba(210,153,34,0.05) 0%, rgba(210,153,34,0.6) 20%, rgba(210,153,34,0.8) 50%, rgba(210,153,34,0.6) 80%, rgba(210,153,34,0.05) 100%); -webkit-mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite:xor; mask-composite:exclude; z-index:-1; transition:all 0.25s ease; }',
        '#eproc-dashboard .btn-sober-gold:hover { background:rgba(210,153,34,0.12); }',
        '#eproc-dashboard.light-mode .btn-sober-gold { color:#475569; }',
        '#eproc-dashboard.light-mode .btn-sober-gold:hover { background:rgba(210,153,34,0.15); }',
        '#eproc-dashboard #eproc-btn-export-json::before, #eproc-dashboard #eproc-btn-import-json::before, #eproc-dashboard #eproc-btn-hist-proc::before, #eproc-dashboard #eproc-btn-processos::before { display:none; }',
        '#eproc-dashboard #eproc-btn-export-json, #eproc-dashboard #eproc-btn-import-json, #eproc-dashboard #eproc-btn-hist-proc, #eproc-dashboard #eproc-btn-processos { box-shadow:0 1px 3px rgba(0,0,0,0.15); }',
        '#eproc-dashboard .ver-mais-processos { color: #58a6ff; margin-left: 4px; }',
        '#eproc-dashboard .ver-mais-processos:hover { color: #c9d1d9; }',

        '#eproc-dashboard .hist-bar { display:flex; align-items:center; gap:4px; }',
        '#eproc-dashboard .hist-bar .hist-input { flex:0 1 200px; padding:4px 8px; font-size:11px; border:1px solid #30363d; border-radius:4px; background:#0d1117; color:#c9d1d9; outline:none; }',
        '#eproc-dashboard .hist-bar .hist-input:focus { border-color:#58a6ff; }',
        '#eproc-dashboard .hist-bar .hist-spacer { flex:1; }',
        '#eproc-dashboard.light-mode .hist-bar .hist-input { border-color:#e4e4e7; background:#f8fafc; color:#0f172a; }',
        '#eproc-dashboard.light-mode .hist-bar .hist-input:focus { border-color:#0f62fe; }',

        '#eproc-hist-overlay { display:none; position:fixed; inset:0; z-index:999999; align-items:center; justify-content:center; background:rgba(0,0,0,0.6); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); }',
        '#eproc-hist-overlay.active { display:flex; }',
        '#eproc-hist-overlay .eproc-modal { background:#0d1117; border:1px solid #30363d; border-radius:14px; width:92%; max-width:720px; max-height:85vh; overflow:hidden; box-shadow:0 12px 48px rgba(0,0,0,0.5); transform:scale(0.96); opacity:0; transition:transform 0.25s ease, opacity 0.25s ease; }',
        '#eproc-hist-overlay.active .eproc-modal { transform:scale(1); opacity:1; }',
        '#eproc-hist-overlay .modal-header { padding:14px 20px; background:#0d1117; border-bottom:1px solid #21262d; display:flex; justify-content:space-between; align-items:center; }',
        '#eproc-hist-overlay .modal-header .m-title { font-size:14px; font-weight:700; color:#e6edf3; display:flex; align-items:center; gap:8px; }',
        '#eproc-hist-overlay .modal-header .m-close { background:transparent; border:none; color:#8b949e; font-size:20px; cursor:pointer; border-radius:6px; width:32px; height:32px; display:flex; align-items:center; justify-content:center; transition:0.15s; }',
        '#eproc-hist-overlay .modal-header .m-close:hover { color:#e6edf3; background:#21262d; }',
        '#eproc-hist-overlay .modal-body { padding:16px 20px 20px; }',
        '#eproc-hist-overlay .hist-search-row { display:flex; gap:8px; margin-bottom:14px; }',
        '#eproc-hist-overlay #eproc-hist-input { flex:1; padding:8px 12px; font-size:12px; border:1px solid #30363d; border-radius:6px; background:#161b22; color:#c9d1d9; outline:none; transition:0.15s; }',
        '#eproc-hist-overlay #eproc-hist-input:focus { border-color:#58a6ff; box-shadow:0 0 0 3px rgba(88,166,255,0.15); }',
        '#eproc-hist-overlay #eproc-hist-search { border:none; outline:none; padding:6px 18px; font-size:11px; cursor:pointer; border-radius:6px; background:transparent; color:#c9d1d9; transition:all 0.25s ease; position:relative; z-index:1; }',
        '#eproc-hist-overlay #eproc-hist-search::before { content:""; position:absolute; inset:0; border-radius:6px; padding:0.5px; background:linear-gradient(90deg, rgba(210,153,34,0.05) 0%, rgba(210,153,34,0.6) 20%, rgba(210,153,34,0.8) 50%, rgba(210,153,34,0.6) 80%, rgba(210,153,34,0.05) 100%); -webkit-mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite:xor; mask-composite:exclude; z-index:-1; }',
        '#eproc-hist-overlay #eproc-hist-search:hover { background:rgba(210,153,34,0.12); }',
        '#eproc-hist-overlay #eproc-hist-results { max-height:380px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#30363d transparent; }',
        '#eproc-hist-overlay #eproc-hist-results .hr-total { font-size:15px; font-weight:700; color:#e6edf3; padding:0 0 14px 0; border-bottom:1px solid #21262d; margin-bottom:0; }',
        '#eproc-hist-overlay #eproc-hist-results .hr-total .hl-proc { color:#58a6ff; }',
        '#eproc-hist-overlay #eproc-hist-results table { width:100%; border-collapse:collapse; font-size:11px; }',
        '#eproc-hist-overlay #eproc-hist-results th { text-align:left; padding:10px 10px; color:#8b949e; font-weight:600; font-size:10px; text-transform:uppercase; letter-spacing:.6px; border-bottom:1px solid #21262d; position:sticky; top:0; background:#0d1117; z-index:1; }',
        '#eproc-hist-overlay #eproc-hist-results td { padding:9px 10px; border-bottom:1px solid #161b22; color:#c9d1d9; vertical-align:middle; }',
        '#eproc-hist-overlay #eproc-hist-results tbody tr:hover td { background:rgba(255,255,255,0.02); }',
        '#eproc-hist-overlay #eproc-hist-results td.col-data { color:#8b949e; font-size:11px; }',
        '#eproc-hist-overlay #eproc-hist-results td.col-regra { font-size:12px; font-weight:600; }',
        '#eproc-hist-overlay #eproc-hist-results .grupo-badge { display:inline-block; padding:2px 10px; border-radius:4px; font-size:10px; font-weight:500; white-space:nowrap; }',
        '#eproc-hist-overlay.light-mode { background:rgba(255,255,255,0.7); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); }',
        '#eproc-hist-overlay.light-mode .eproc-modal { background:#ffffff; border-color:#e4e4e7; box-shadow:0 12px 48px rgba(0,0,0,0.08); }',
        '#eproc-hist-overlay.light-mode .modal-header { background:#f8fafc; border-color:#e4e4e7; }',
        '#eproc-hist-overlay.light-mode .modal-header .m-title { color:#0f172a; }',
        '#eproc-hist-overlay.light-mode .modal-header .m-close { color:#64748b; }',
        '#eproc-hist-overlay.light-mode .modal-header .m-close:hover { color:#0f172a; background:#f1f5f9; }',
        '#eproc-hist-overlay.light-mode #eproc-hist-input { background:#f8fafc; border-color:#e4e4e7; color:#0f172a; }',
        '#eproc-hist-overlay.light-mode #eproc-hist-input:focus { border-color:#0f62fe; box-shadow:0 0 0 3px rgba(15,98,254,0.12); }',
        '#eproc-hist-overlay.light-mode #eproc-hist-search { color:#475569; }',
        '#eproc-hist-overlay.light-mode #eproc-hist-search:hover { background:rgba(210,153,34,0.15); }',
        '#eproc-hist-overlay.light-mode #eproc-hist-results .hr-total { color:#0f172a; border-color:#e4e4e7; }',
        '#eproc-hist-overlay.light-mode #eproc-hist-results .hr-total .hl-proc { color:#0f62fe; }',
        '#eproc-hist-overlay.light-mode #eproc-hist-results th { color:#64748b; border-color:#e4e4e7; background:#ffffff; }',
        '#eproc-hist-overlay.light-mode #eproc-hist-results td { color:#475569; border-color:#f1f5f9; }',
        '#eproc-hist-overlay.light-mode #eproc-hist-results tbody tr:hover td { background:rgba(0,0,0,0.015); }',
        '#eproc-hist-overlay.light-mode #eproc-hist-results td.col-data { color:#94a3b8; }',

        '#eproc-dashboard .charts-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }',
        '#eproc-dashboard .chart-box { background:#0d1117; border:1px solid #21262d; border-radius:8px; padding:10px; position:relative; display:flex; flex-direction:column; transition: opacity 0.4s ease, transform 0.4s ease; }',
        '#eproc-dashboard .chart-box.full { grid-column:1 / -1; }',
        '#eproc-dashboard .chart-box .ch-title { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; flex-shrink:0; }',
        '#eproc-dashboard .chart-box .ch-body { flex:1; min-height:280px; max-height:400px; position:relative; width:100%; display:flex; align-items:center; justify-content:center; }',
        '#eproc-dashboard .chart-box.scrollable .ch-body { overflow-y:auto; overflow-x:hidden; align-items:flex-start; min-height:350px; }',
        '#eproc-dashboard .chart-box.scrollable .ch-body::-webkit-scrollbar { width:4px; }',
        '#eproc-dashboard .chart-box.scrollable .ch-body::-webkit-scrollbar-thumb { background:#30363d; border-radius:2px; }',
        '#eproc-dashboard .chart-box .ch-title span { font-size:10px; font-weight:600; color:#e6edf3; }',
        '#eproc-dashboard .chart-box .ch-title .ch-actions { display:flex; gap:4px; align-items:center; }',
        '#eproc-dashboard .chart-box .ch-title .ch-actions button { background:transparent; border:none; color:#484f58; cursor:pointer; font-size:9px; padding:2px 5px; border-radius:3px; transition:all 0.15s; font-family:inherit; }',
        '#eproc-dashboard .chart-box .ch-title .ch-actions button:hover { color:#8b949e; background:#21262d; }',
        '#eproc-dashboard .chart-box .ch-dims { display:flex; gap:3px; margin-bottom:4px; }',
        '#eproc-dashboard .chart-box .ch-dims span { padding:1px 6px; border-radius:3px; font-size:8px; cursor:pointer; background:#21262d; color:#484f58; transition:all 0.15s; }',
        '#eproc-dashboard .chart-box .ch-dims span:hover { color:#8b949e; }',
        '#eproc-dashboard .chart-box .ch-dims span.active { background:#1f6feb33; color:#58a6ff; font-weight:600; }',
        '#eproc-dashboard .chart-box canvas { width:100% !important; max-height:100%; }',
        '#eproc-dashboard .chart-box.scrollable canvas { height:auto !important; max-height:none; }',

        /* Table */
        '#eproc-dashboard .data-table-wrap { background:#0d1117; border:1px solid #21262d; border-radius:8px; padding:10px; }',
        '#eproc-dashboard .data-table-wrap .dt-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }',
        '#eproc-dashboard .data-table-wrap .dt-header .dt-title { font-size:10px; font-weight:600; color:#e6edf3; }',
        '#eproc-dashboard .data-table-wrap .dt-header .dt-actions { display:flex; gap:4px; }',
        '#eproc-dashboard .data-table-wrap .dt-header .dt-actions input { padding:3px 8px; background:#161b22; border:1px solid #30363d; border-radius:5px; font-size:9px; color:#e6edf3; width:90px; font-family:inherit; }',
        '#eproc-dashboard .data-table-wrap .dt-header .dt-actions .btn-processos { background:#21262d; color:#8b949e; }',
        '#eproc-dashboard .data-table-wrap .dt-header .dt-actions .btn-processos:hover { background:#30363d; color:#e6edf3; }',
        '#eproc-dashboard .data-table-wrap .dt-header .dt-actions .btn-processos.active { background:#1f6feb33; color:#58a6ff; }',

        '#eproc-dashboard .data-table { width:100%; border-collapse:collapse; font-size:10px; }',
        '#eproc-dashboard .data-table th { text-align:left; padding:5px 6px; font-weight:600; color:#8b949e; border-bottom:1px solid #21262d; cursor:pointer; white-space:nowrap; }',
        '#eproc-dashboard .data-table th:hover { color:#e6edf3; }',
        '#eproc-dashboard .data-table td { padding:4px 6px; border-bottom:1px solid #21262d; color:#8b949e; }',
        '#eproc-dashboard .data-table tr:hover td { background:#161b22; }',
        '#eproc-dashboard .data-table td.proc-cell { font-style:italic; color:#484f58; }',
        '#eproc-dashboard .data-table td.proc-cell a { color:#58a6ff; text-decoration:none; }',
        '#eproc-dashboard .data-table td.proc-cell a:hover { text-decoration:underline; }',
        '#eproc-dashboard .data-table td.val { font-weight:600; color:#e6edf3; }',
        '#eproc-dashboard .data-table td.regra-num { font-weight:500; color:#e6edf3; }',

        '#eproc-dashboard .dt-footer { display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:8px; color:#484f58; }',
        '#eproc-dashboard .dt-footer .dt-pages { display:flex; gap:3px; }',
        '#eproc-dashboard .dt-footer .dt-pages span { padding:2px 5px; border:1px solid #21262d; border-radius:3px; cursor:pointer; color:#484f58; transition:all 0.15s; }',
        '#eproc-dashboard .dt-footer .dt-pages span:hover { border-color:#30363d; color:#8b949e; }',
        '#eproc-dashboard .dt-footer .dt-pages span.active { background:#1f6feb33; border-color:#1f6feb44; color:#58a6ff; font-weight:600; }',
        
        /* Global Footer */
        '#eproc-dashboard .global-footer { position:absolute; bottom:0; left:0; right:0; height:40px; background:#0d1117; border-top:1px solid #21262d; display:flex; justify-content:space-between; align-items:center; padding:0 16px; z-index:100; border-radius: 0 0 12px 12px; }',
        '#eproc-dashboard .global-footer .gf-left { font-size:10px; color:#8b949e; font-weight:500; }',
        '#eproc-dashboard .global-footer .gf-right { display:flex; gap:8px; }',

        /* Process List Modal (bottom right) */
        '#eproc-processos-overlay { display:none; position:fixed; bottom:16px; right:16px; z-index:1000001; width:480px; max-width:90vw; max-height:60vh; background:#161b22; border:1px solid #30363d; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,0.5); overflow:hidden; }',
        '#eproc-processos-overlay.active { display:block; }',
        '#eproc-processos-overlay .pl-header { padding:10px 14px; background:#0d1117; border-bottom:1px solid #21262d; display:flex; justify-content:space-between; align-items:center; }',
        '#eproc-processos-overlay .pl-header span { font-size:12px; font-weight:600; color:#e6edf3; }',
        '#eproc-processos-overlay .pl-header button { background:transparent; border:none; color:#8b949e; cursor:pointer; font-size:14px; padding:2px 6px; border-radius:4px; }',
        '#eproc-processos-overlay .pl-header button:hover { color:#e6edf3; background:#21262d; }',
        '#eproc-processos-overlay .pl-body { padding:8px 14px; max-height:45vh; overflow-y:auto; }',
        '#eproc-processos-overlay .pl-body::-webkit-scrollbar { width:6px; }',
        '#eproc-processos-overlay .pl-body::-webkit-scrollbar-thumb { background:#30363d; border-radius:3px; }',
        '#eproc-processos-overlay .pl-item { padding:5px 0; border-bottom:1px solid #21262d; display:flex; justify-content:space-between; align-items:center; font-size:10px; }',
        '#eproc-processos-overlay .pl-item:last-child { border-bottom:none; }',
        '#eproc-processos-overlay .pl-item .pl-proc { color:#e6edf3; }',
        '#eproc-processos-overlay .pl-item .pl-proc a { color:#58a6ff; text-decoration:none; }',
        '#eproc-processos-overlay .pl-item .pl-proc a:hover { text-decoration:underline; }',
        '#eproc-processos-overlay .pl-item .pl-meta { color:#c9d1d9; font-weight:500; }',
        '#eproc-processos-overlay .pl-count { padding:6px 14px; border-top:1px solid #21262d; font-size:10px; color:#c9d1d9; font-weight:600; text-align:center; }',

        /* Scrollbar general */
        '#eproc-dashboard ::-webkit-scrollbar { width:5px; }',
        '#eproc-dashboard ::-webkit-scrollbar-track { background:transparent; }',
        '#eproc-dashboard ::-webkit-scrollbar-thumb { background:#30363d; border-radius:3px; }',
    ].join('');

    // ================================================================
    // CSS INJECTION
    // ================================================================
    var LIGHT_CSS = [
        '#eproc-dashboard.light-mode, #eproc-processos-overlay.light-mode { background:#ffffff; border-color:#e4e4e7; box-shadow:0 10px 40px -10px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.02); }',
        '#eproc-dashboard.light-mode .dash-header, #eproc-dashboard.light-mode .tab-bar, #eproc-processos-overlay.light-mode .pl-header { background:#f8fafc; }',
        '#eproc-dashboard.light-mode .htitle, #eproc-dashboard.light-mode .chart-box .ch-title span, #eproc-dashboard.light-mode .data-table-wrap .dt-header .dt-title, #eproc-dashboard.light-mode .kpi-card .kpi-num, #eproc-dashboard.light-mode .tab-bar .tab-btn.active, #eproc-dashboard.light-mode .stats-box td.value, #eproc-dashboard.light-mode .data-table td.val, #eproc-processos-overlay.light-mode .pl-header span { color:#0f172a; }',
        '#eproc-dashboard.light-mode .hstatus, #eproc-dashboard.light-mode .tab-bar .tab-btn, #eproc-dashboard.light-mode .tab-bar .tab-btn .tbadge, #eproc-dashboard.light-mode .ext-footer button, #eproc-dashboard.light-mode .filter-sidebar .fs-title, #eproc-dashboard.light-mode .filter-sidebar .fs-label, #eproc-dashboard.light-mode .stats-box td.label, #eproc-dashboard.light-mode .log-entry, #eproc-dashboard.light-mode .rel-loading, #eproc-dashboard.light-mode .rel-empty, #eproc-dashboard.light-mode .chart-box .ch-title .ch-actions button, #eproc-dashboard.light-mode .dt-footer, #eproc-dashboard.light-mode .dt-footer .dt-pages span, #eproc-dashboard.light-mode .data-table th:not(:hover), #eproc-dashboard.light-mode .data-table td.regra-num { color:#1e293b; }',
        '#eproc-dashboard.light-mode .dash-summary, #eproc-dashboard.light-mode .kpi-card .kpi-label, #eproc-dashboard.light-mode .kpi-card .kpi-delta, #eproc-dashboard.light-mode .data-table td, #eproc-dashboard.light-mode .glossary-box .g-row, #eproc-dashboard.light-mode .tooltip-box .tt-row, #eproc-dashboard.light-mode .chart-box .ch-dims span, #eproc-dashboard.light-mode .rel-empty .e-sub, #eproc-dashboard.light-mode .filter-sidebar .fs-presets span { color:#64748b; }',
        '#eproc-dashboard.light-mode .stats-box, #eproc-dashboard.light-mode .filter-sidebar, #eproc-dashboard.light-mode .dash-summary, #eproc-dashboard.light-mode .kpi-card, #eproc-dashboard.light-mode .chart-box, #eproc-dashboard.light-mode .data-table-wrap, #eproc-dashboard.light-mode .glossary-box, #eproc-dashboard.light-mode .log-area, #eproc-dashboard.light-mode .tooltip-box, #eproc-dashboard.light-mode .rel-empty, #eproc-dashboard.light-mode .filter-sidebar .fs-field, #eproc-dashboard.light-mode .data-table-wrap .dt-header .dt-actions input { background:#f8fafc; border-color:#e4e4e7; }',
        '#eproc-dashboard.light-mode .ext-footer, #eproc-dashboard.light-mode .dash-header, #eproc-dashboard.light-mode .tab-bar, #eproc-dashboard.light-mode .stats-box td, #eproc-dashboard.light-mode .log-entry, #eproc-dashboard.light-mode .tooltip-box .tt-row, #eproc-dashboard.light-mode .data-table th, #eproc-dashboard.light-mode .data-table td, #eproc-dashboard.light-mode .dt-footer .dt-pages span, #eproc-dashboard.light-mode .filter-sidebar .fs-divider, #eproc-dashboard.light-mode .stats-box td, #eproc-processos-overlay.light-mode .pl-header, #eproc-processos-overlay.light-mode .pl-item, #eproc-processos-overlay.light-mode .pl-count { border-color:#e4e4e7; }',
        '#eproc-dashboard.light-mode .ext-footer button { background:#ffffff; color:#475569; border-color:#e4e4e7; }',
        '#eproc-dashboard.light-mode .stats-box tr:hover td, #eproc-dashboard.light-mode .data-table tr:hover td, #eproc-dashboard.light-mode .log-entry:hover { background:#f1f5f9; }',
        '#eproc-dashboard.light-mode .filter-sidebar .fs-field, #eproc-dashboard.light-mode .data-table-wrap .dt-header .dt-actions input { background:#ffffff; color:#0f172a; border-color:#e4e4e7; }',
        '#eproc-dashboard.light-mode .filter-sidebar .fs-presets span { background:#f1f5f9; }',
        '#eproc-dashboard.light-mode .filter-sidebar .fs-presets span:hover { background:#e2e8f0; color:#0f172a; }',
        '#eproc-dashboard.light-mode .filter-sidebar .fs-presets span.active { background:#e0f2fe; color:#0369a1; border-color:#0369a144; }',
        '#eproc-dashboard.light-mode .filter-sidebar .fs-ord-toggle span { background:#f1f5f9; color:#64748b; }',
        '#eproc-dashboard.light-mode .filter-sidebar .fs-ord-toggle span.active { background:#e0f2fe; color:#0369a1; }',
        '#eproc-dashboard.light-mode .filter-sidebar .fs-btn.secondary { background:#f1f5f9; color:#475569; }',
        '#eproc-dashboard.light-mode .filter-sidebar .fs-btn.secondary:hover { background:#e2e8f0; color:#0f172a; }',
        '#eproc-dashboard.light-mode .chart-box .ch-dims span { background:#f1f5f9; color:#64748b; }',
        '#eproc-dashboard.light-mode .chart-box .ch-dims span.active { background:#e0f2fe; color:#0369a1; }',
        '#eproc-dashboard.light-mode .chart-box .ch-title .ch-actions button:hover { background:#f1f5f9; color:#475569; }',
        '#eproc-dashboard.light-mode .data-table-wrap .dt-header .dt-actions .btn-processos { background:#f1f5f9; color:#475569; }',
        '#eproc-dashboard.light-mode .data-table-wrap .dt-header .dt-actions .btn-processos:hover { background:#e2e8f0; color:#0f172a; }',
        '#eproc-dashboard.light-mode .data-table-wrap .dt-header .dt-actions .btn-processos.active { background:#e0f2fe; color:#0369a1; }',
        '#eproc-dashboard.light-mode .dt-footer .dt-pages span:hover { border-color:#cbd5e1; color:#0f172a; }',
        '#eproc-dashboard.light-mode .dt-footer .dt-pages span.active { background:#e0f2fe; border-color:#0369a144; color:#0369a1; }',
        '#eproc-dashboard.light-mode .ext-footer button:hover { background:#f1f5f9; border-color:#cbd5e1; color:#0f172a; }',
        '#eproc-dashboard.light-mode .ext-footer button.primary { color:#0f62fe; border-color:#0f62fe; }',
        '#eproc-dashboard.light-mode .ext-footer button.primary:hover { background:#edf3ff; }',
        '#eproc-dashboard.light-mode .ext-footer button.success { color:#10b981; border-color:#10b98133; }',
        '#eproc-dashboard.light-mode .ext-footer button.success:hover { background:#ecfdf5; }',
        '#eproc-dashboard.light-mode .ext-footer button.danger { color:#ef4444; border-color:#ef444433; }',
        '#eproc-dashboard.light-mode .ext-footer button.danger:hover { background:#fef2f2; }',
        '#eproc-dashboard.light-mode .glossary-box .g-row .g-label { color:#64748b; }',
        '#eproc-dashboard.light-mode .tooltip-box .tt-value { color:#0f172a; }',
        '#eproc-dashboard.light-mode .rel-empty button { background:#0f62fe; }',
        '#eproc-dashboard.light-mode ::-webkit-scrollbar-thumb { background:#cbd5e1; }',
        '#eproc-dashboard.light-mode .rel-body::-webkit-scrollbar-thumb { background:#cbd5e1; }',
        '#eproc-dashboard.light-mode .glossary-box::-webkit-scrollbar-thumb { background:#cbd5e1; }',
        '#eproc-dashboard.light-mode .pausado-badge { color:#ffffff; }',
        '#eproc-dashboard.light-mode .tab-bar .tab-btn .status-badge.ativos { background:#d1fae5; color:#065f46; }',
        '#eproc-dashboard.light-mode .tab-bar .tab-btn .status-badge.desatualizado { background:#fef3c7; color:#92400e; }',
        '#eproc-dashboard.light-mode .tab-bar .tab-btn.active .tbadge { background:#e0f2fe; color:#0369a1; }',
        '#eproc-dashboard.light-mode .hactions button:hover { background:#f1f5f9; color:#0f172a; }',
        '#eproc-dashboard.light-mode .bar-bg { background:#f1f5f9; }',
        '#eproc-dashboard.light-mode .rel-loading .spinner { border-color:#f1f5f9; border-top-color:#0f62fe; }',
        '#eproc-dashboard.light-mode .data-table td.proc-cell a { color:#0f62fe; }',

        '#eproc-processos-overlay.light-mode { background:#ffffff; border-color:#e4e4e7; }',
        '#eproc-processos-overlay.light-mode .pl-header { background:#f8fafc; border-color:#e4e4e7; }',
        '#eproc-processos-overlay.light-mode .pl-header span { color:#0f172a; }',
        '#eproc-processos-overlay.light-mode .pl-header button:hover { background:#f1f5f9; color:#0f172a; }',
        '#eproc-processos-overlay.light-mode .pl-body::-webkit-scrollbar-thumb { background:#cbd5e1; }',
        '#eproc-processos-overlay.light-mode .pl-item { border-color:#e4e4e7; }',
        '#eproc-processos-overlay.light-mode .pl-item .pl-proc { color:#0f172a; }',
        '#eproc-processos-overlay.light-mode .pl-item .pl-proc a { color:#0f62fe; }',
        '#eproc-processos-overlay.light-mode .pl-count { border-color:#e4e4e7; color:#64748b; }',
        '#eproc-dashboard.light-mode .filter-sidebar .fs-field:focus { border-color:#0f62fe; box-shadow:0 0 0 2px rgba(15,98,254,0.15); }',
        '#eproc-dashboard.light-mode .tab-refresh-btn { color:#64748b; }',
        '#eproc-dashboard.light-mode .tab-refresh-btn:hover { color:#0f62fe !important; }',
        '#eproc-dashboard.light-mode .ver-mais-processos { color: #0f62fe; }',
        '#eproc-dashboard.light-mode .ver-mais-processos:hover { color: #0f172a; }',
        '#eproc-dashboard.light-mode .rg-paral { background:#f8fafc; border-color:#e4e4e7; }',
        '#eproc-dashboard.light-mode .rg-paral-title { color:#0f172a; }',
        '#eproc-dashboard.light-mode .rg-paral-item:nth-child(even) { background:#f1f5f9; border-radius:4px; }',
        '#eproc-dashboard.light-mode .rg-paral-left { color:#0f172a; }',
        '#eproc-dashboard.light-mode .rg-paral-left span { color:#64748b; }',
        '#eproc-dashboard.light-mode .rg-paral-right { color:#64748b; }',
        '#eproc-dashboard.light-mode .rg-paral-ultima { color:#94a3b8; }',
        '#eproc-dashboard.light-mode #eproc-btn-export-json, #eproc-dashboard.light-mode #eproc-btn-import-json, #eproc-dashboard.light-mode #eproc-btn-hist-proc, #eproc-dashboard.light-mode #eproc-btn-processos { box-shadow:0 1px 3px rgba(0,0,0,0.06); }',
    ].join('\n');

    function injectCSS() {
        var style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        var lightStyle = document.createElement('style');
        lightStyle.id = 'eproc-light-css';
        lightStyle.textContent = LIGHT_CSS;
        document.head.appendChild(lightStyle);
    }

    function aplicarTema(forcarRender) {
        var dash = document.getElementById('eproc-dashboard');
        if (!dash) return;
        var procModal = document.getElementById('eproc-processos-overlay');
        var histModal = document.getElementById('eproc-hist-overlay');

        if (state.darkMode) {
            dash.classList.remove('light-mode');
            if (procModal) procModal.classList.remove('light-mode');
            if (histModal) histModal.classList.remove('light-mode');
        } else {
            dash.classList.add('light-mode');
            if (procModal) procModal.classList.add('light-mode');
            if (histModal) histModal.classList.add('light-mode');
        }

        // Re-renderiza os gráficos com as novas cores do tema atualizado somente se solicitado
        if (forcarRender && state.dadosFiltrados && state.dadosFiltrados.length > 0) {
            renderDashboard();
        }
    }

    // ================================================================
    // UI BUILDER
    // ================================================================
    function criarUI() {
        injectCSS();

        // ---- MINI BUTTON ----
        var miniBtn = document.createElement('div');
        miniBtn.id = 'eproc-mini-btn';
        miniBtn.title = 'Abrir Projeto LOG';
        miniBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>';
        document.body.appendChild(miniBtn);

        // ---- DASHBOARD ----
        var statusClass = atualizarStatusExtracao();
        var dash = document.createElement('div');
        dash.id = 'eproc-dashboard';
        dash.className = 'compact';
        dash.innerHTML =
            '<div class="dash-header" id="eproc-dash-header">' +
            '  <div class="htitle">' +
            '    <span class="hicon">📊</span>' +
            '    <span>Projeto LOGsEproc</span>' +
            '  </div>' +
            '  <div class="hstatus"><span class="dot" id="eproc-conn-dot"></span><span id="eproc-conn-text">Conectado - ' + escHTML(state.perfilAtual || PERFIL_ATUAL) + '</span></div>' +
            '  <div class="hactions">' +
            '    <button id="eproc-btn-theme" title="Alternar tema"></button>' +
            '    <button id="eproc-btn-viewmode" title="Maximizar"><span class="viewmode-icon"></span></button>' +
            '    <button id="eproc-btn-fechar" title="Minimizar">✕</button>' +
            '  </div>' +
            '</div>' +
            '<div class="tab-bar" style="display:flex; justify-content:flex-start; align-items:center; padding-right:8px;">' +
            '  <div style="display:flex; gap:2px; align-items:center;">' +
            '    <button class="tab-btn active" data-tab="extracao">' +
            '      Extrair Dados' +
            '      <span class="status-badge ' + statusClass + '" id="eproc-status-badge">' + (statusClass === 'ativos' ? 'Atualizado' : 'Desatualizado') + '</span>' +
            '    </button>' +
            '    <button class="tab-btn" data-tab="relatorios">' +
            '      Relatórios' +
            '      <span class="tbadge" id="eproc-rel-badge">0</span>' +
            '    </button>' +
            '    <button class="tab-refresh-btn" id="eproc-btn-sync-manual" title="Atualizar dados" style="background:transparent; border:none; color:#8b949e; cursor:pointer; font-size:16px; padding:6px 10px; display:flex; align-items:center; transition:all 0.15s; font-family:inherit; font-weight:bold;">↻</button>' +
            '  </div>' +
            '</div>' +

            /* TAB 1 - EXTRACAO */
            '<div id="tab-extracao" class="tab-content active">' +
            '  <div class="ext-body">' +
            '    <div class="stats-box" id="eproc-stats-area">' +
            '      <table>' +
            '        <tr><td class="label">Regras processadas</td><td class="value" id="eproc-stat-regras">0 / 0</td></tr>' +
            '        <tr><td class="label">Extraídos</td><td class="value" id="eproc-stat-extraidos">0</td></tr>' +
            '        <tr><td class="label" style="color:#58a6ff">Enviados (Novos)</td><td class="value info" id="eproc-stat-novos">0</td></tr>' +
            '        <tr><td class="label">Ignorados (já existiam)</td><td class="value" id="eproc-stat-ignorados">0</td></tr>' +
            '        <tr><td class="label">Duplicados Descartados</td><td class="value" id="eproc-stat-duplicados">0</td></tr>' +
            '        <tr><td class="label warn">Erros/Falhas</td><td class="value warn" id="eproc-stat-erros">0</td></tr>' +
            '        <tr><td class="label">Erros Extração</td><td class="value" id="eproc-stat-erros-fetch">0</td></tr>' +
            '        <tr><td class="label">Erros Envio</td><td class="value" id="eproc-stat-erros-flush">0</td></tr>' +
            '        <tr><td class="label">Tempo estimado</td><td class="value" id="eproc-stat-eta">--:--</td></tr>' +
            '      </table>' +
            '      <div class="tooltip-box" id="eproc-tooltip"></div>' +
            '    </div>' +
            '    <div class="bar-bg"><div class="bar-fill" id="eproc-bar"></div></div>' +
            '    <div class="log-area" id="eproc-log-list"></div>' +
            '  </div>' +
            '  <div class="ext-footer">' +
            '    <button class="primary" id="eproc-btn-importar">▶ Importar Logs</button>' +
            '  </div>' +
            '</div>' +

            /* TAB 2 - RELATORIOS */
            '<div id="tab-relatorios" class="tab-content">' +
            '  <div class="rel-body" id="eproc-rel-body">' +
            '    <div class="rel-loading" id="eproc-rel-loading">' +
            '      <div class="spinner"></div>' +
            '      <div class="spinner-text">Carregando dados da planilha...</div>' +
            '      <div style="font-size:10px; color:#8b949e; margin-top:6px;" id="eproc-rel-loading-sub">Iniciando conexão...</div>' +
            '    </div>' +
            '    <div class="rel-empty" id="eproc-rel-empty" style="display:none;">' +
            '      <div class="e-icon">📭</div>' +
            '      <div class="e-text">Nenhum dado encontrado</div>' +
            '      <div class="e-sub">Execute uma extração na aba "Extrair Dados" primeiro, ou clique para recarregar.</div>' +
            '      <button id="eproc-rel-retry">🔄 Recarregar Dados</button>' +
            '    </div>' +
            '    <div class="dash-grid" id="eproc-dash-grid" style="display:none;">' +
            '      <div class="filter-sidebar" id="eproc-rel-filters">' +
            '        <div class="fs-title">Filtros</div>' +
            '        <div class="fs-label">Período</div>' +
            '        <div class="fs-row">' +
            '          <input type="date" class="fs-field" id="eproc-filtro-data-inicio">' +
            '          <input type="date" class="fs-field" id="eproc-filtro-data-fim">' +
            '        </div>' +
            '        <div class="fs-presets" id="eproc-date-presets">' +
            '          <span data-preset="hoje">Hoje</span>' +
            '          <span data-preset="7d">7 dias</span>' +
            '          <span data-preset="15d">15 dias</span>' +
            '          <span data-preset="30d">30 dias</span>' +
            '          <span data-preset="mes">Mês</span>' +
            '          <span data-preset="ano">Ano</span>' +
            '          <span data-preset="tudo" class="active">Tudo</span>' +
            '        </div>' +
            '        <div class="fs-label">Grupo de Automação</div>' +
            '        <select class="fs-field" id="eproc-filtro-grupo">' +
            '          <option value="todos">Todos</option>' +
            '        </select>' +
            '        <div class="fs-label">Regra</div>' +
            '        <select class="fs-field" id="eproc-filtro-regra">' +
            '          <option value="todas">Todas</option>' +
            '        </select>' +
            '        <div class="fs-label">Nº do Processo</div>' +
            '        <input class="fs-field" id="eproc-filtro-processo" placeholder="Nº do processo..." style="font-size:10px;">' +
            '        <hr class="fs-divider">' +
            '        <div class="fs-label">Ordenar por:</div>' +
            '        <div class="fs-ord-toggle">' +
'          <span class="active" data-ordem="frequencia-desc"><strong style="font-size:1.4em;line-height:1">+</strong>Frequentes</span>' +
'          <span data-ordem="frequencia-asc"><strong style="font-size:1.4em;line-height:1">-</strong>Frequentes</span>' +
            '        </div>' +
            '        <hr class="fs-divider">' +
            '        <button class="fs-btn secondary" id="eproc-btn-limpar">Limpar</button>' +
            '        <div id="eproc-regras-paralisadas"></div>' +
            '        <hr class="fs-divider">' +
            '        <div class="fs-label">Glossário</div>' +
            '        <select class="fs-field" id="eproc-glossario-select">' +
            '          <option value="">Selecione uma regra...</option>' +
            '        </select>' +
            '        <div class="glossary-box" id="eproc-glossario-box" style="display:none;"></div>' +
            '      </div>' +
            '      <div class="dash-main" id="eproc-dash-main">' +
            '        <div class="dash-summary" id="eproc-dash-summary">📌 Carregue os dados para ver o resumo.</div>' +
            '        <div class="kpi-row">' +
            '          <div class="kpi-card kpi-card-exec"><div class="kpi-top"><div class="kpi-num" id="kpi-exec">—</div><div class="kpi-delta" id="kpi-exec-delta"></div></div><div class="kpi-label">Execuções</div></div>' +
            '          <div class="kpi-card kpi-card-exec"><div class="kpi-top"><div class="kpi-num" id="kpi-media-exec">—</div></div><div class="kpi-label">Média de Execuções / Dia</div></div>' +
            '          <div class="kpi-card kpi-card-proc"><div class="kpi-top"><div class="kpi-num" id="kpi-proc">—</div><div class="kpi-delta" id="kpi-proc-delta"></div></div><div class="kpi-label">Processos Impactados</div></div>' +
            '          <div class="kpi-card kpi-card-proc"><div class="kpi-top"><div class="kpi-num" id="kpi-media-proc">—</div></div><div class="kpi-label">Média de Processos / Dia</div></div>' +
            '        </div>' +
            '        <div class="charts-grid">' +
            '          <div class="chart-box full" id="chart-temporal-wrap">' +
            '            <div class="ch-title"><div style="display:flex;align-items:center;gap:8px"><span>Série Temporal</span><button class="btn-sober-gold" id="eproc-metrica-toggle">Execuções</button></div><div class="ch-actions"><button class="btn-chart-png" data-chart="temporal"><img width="16" height="16" src="https://img.icons8.com/metro/26/download.png" alt="download" class="icon-invertible" style="vertical-align: middle;"/></button></div></div>' +
            '            <div class="ch-body"><canvas id="chart-temporal"></canvas></div>' +
            '          </div>' +
            '          <div class="chart-box" id="chart-distrib-wrap">' +
            '            <div class="ch-title"><span>Distribuição</span><div class="ch-actions"><button class="btn-chart-png" data-chart="distrib"><img width="16" height="16" src="https://img.icons8.com/metro/26/download.png" alt="download" class="icon-invertible" style="vertical-align: middle;"/></button></div></div>' +
            '            <div class="ch-dims" id="pie-dims">' +
            '              <span data-dim="grupo">Grupo</span>' +
            '              <span data-dim="regra">Regra</span>' +
            '              <span class="active" data-dim="data">Data</span>' +
            '            </div>' +
            '            <div class="ch-body"><canvas id="chart-distrib"></canvas></div>' +
            '          </div>' +
            '          <div class="chart-box scrollable" id="chart-top-wrap">' +
            '            <div class="ch-title"><span>Regras</span><div class="ch-actions"><button class="btn-chart-png" data-chart="top"><img width="16" height="16" src="https://img.icons8.com/metro/26/download.png" alt="download" class="icon-invertible" style="vertical-align: middle;"/></button></div></div>' +
            '            <div class="ch-body">' +
            '              <div style="position:relative; width:100%;" id="chart-top-inner">' +
            '                <canvas id="chart-top"></canvas>' +
            '              </div>' +
            '            </div>' +
            '          </div>' +
            '        </div>' +
            '        <div class="data-table-wrap">' +
            '          <div class="dt-header">' +
            '            <div class="dt-title">Dados Detalhados</div>' +
            '            <div class="dt-actions">' +
            '              <input id="eproc-tabela-busca" placeholder="Buscar...">' +
            '              <button class="btn-sober-gold" id="eproc-btn-xlsx">Relatório Consolidado</button>' +
            '            </div>' +
            '          </div>' +
            '          <div style="overflow-x:auto;">' +
            '            <table class="data-table" id="eproc-data-table">' +
            '              <thead>' +
            '                <tr><th data-sort="regra">Regra</th><th data-sort="grupo">Grupo</th><th data-sort="qtd">Qtd</th><th data-sort="processo">Processo</th></tr>' +
            '              </thead>' +
            '              <tbody id="eproc-table-body"></tbody>' +
            '            </table>' +
            '          </div>' +
            '          <div class="dt-footer">' +
            '            <span id="eproc-table-info">0 registros</span>' +
            '            <div class="dt-pages" id="eproc-table-pages"></div>' +
            '            <div class="hist-bar">' +
            '              <button class="btn-sober-gold" id="eproc-btn-hist-proc">Execuções por Processo</button>' +
            '              <input type="text" id="eproc-hist-input" class="hist-input" placeholder="N\u00BA do processo..." style="display:none">' +
            '              <button class="btn-sober-gold" id="eproc-hist-search" style="display:none;border:none;outline:none;font-size:10px;padding:2px 10px;">Ok</button>' +
            '              <span class="hist-spacer"></span>' +
            '              <button class="btn-sober-gold" id="eproc-btn-processos">Todos os processos</button>' +
            '            </div>' +
            '          </div>' +
            '        </div>' +
            '      </div>' +
            '    </div>' +
            '  </div>' +
            '  <div class="global-footer">' +
            '    <div class="gf-left">Idealizado por ®Allison de Castro Silva</div>' +
            '    <div class="gf-right">' +
            '      <button class="btn-sober-gold" id="eproc-btn-export-json">Exportar dados</button>' +
            '      <button class="btn-sober-gold" id="eproc-btn-import-json">Importar dados</button>' +
            '      <button class="btn-sober-gold" id="eproc-btn-limpar-base">Limpar Banco de Dados</button>' +
            '    </div>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(dash);

        // ---- PROCESSOS MODAL (bottom right) ----
        var procOverlay = document.createElement('div');
        procOverlay.id = 'eproc-processos-overlay';
        procOverlay.innerHTML =
            '<div class="pl-header"><span>📋 Processos do Filtro</span><button id="eproc-pl-close">✕</button></div>' +
            '<div class="pl-body" id="eproc-pl-body"></div>' +
            '<div class="pl-count" id="eproc-pl-count"></div>';
        dash.appendChild(procOverlay);

        // ---- HISTORICO PROCESSO MODAL ----
        var histOverlay = document.createElement('div');
        histOverlay.id = 'eproc-hist-overlay';
        histOverlay.innerHTML =
            '<div class="eproc-modal">' +
            '<div class="modal-header">' +
            '  <span class="m-title">\uD83D\uDD0D Execu\u00E7\u00F5es por Processo</span>' +
            '  <button class="m-close" id="eproc-hist-close">&times;</button>' +
            '</div>' +
            '<div class="modal-body">' +
            '  <div class="hist-search-row">' +
            '    <input type="text" id="eproc-hist-input" placeholder="N\u00FAmero do processo...">' +
            '    <button class="btn-sober-gold" id="eproc-hist-search">Ok</button>' +
            '  </div>' +
            '  <div id="eproc-hist-results"><div style="color:#8b949e;font-size:11px;text-align:center;padding:20px;">Digite um n\u00FAmero de processo e clique em Ok.</div></div>' +
            '</div>' +
            '</div>';
        document.body.appendChild(histOverlay);

        // ---- BIND HELPERS ----
        function bindEl(id, event, fn) {
            var el = document.getElementById(id);
            if (!el) { adicionarLog('§ BIND FALHOU: #' + id + ' n\u00e3o encontrado', 'error'); return; }
            el[event] = fn;
        }
        function bindAll(selector, event, fn) {
            var els = document.querySelectorAll(selector);
            if (!els.length) { adicionarLog('§ BIND FALHOU: "' + selector + '" sem matches', 'error'); return; }
            els.forEach(function(el) { el[event] = fn; });
        }

        // ---- BIND EVENTS ----
        miniBtn.onclick = function () {
            var d = document.getElementById('eproc-dashboard');
            state.viewMode = 'minimized';
            state.compactMode = true;
            var themeClass = (!state.darkMode ? ' light-mode' : '');
            d.className = 'compact show' + themeClass;
            d.style.opacity = '0';
            d.style.transform = 'scale(0.92)';
            miniBtn.style.display = 'none';
            requestAnimationFrame(function () {
                d.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
                d.style.opacity = '1';
                d.style.transform = 'scale(1)';
                setTimeout(function () {
                    d.style.transition = '';
                    d.style.opacity = '';
                    d.style.transform = '';
                    aplicarTema(false);
                }, 260);
            });
        };

        bindEl('eproc-btn-theme', 'onclick', function () {
            state.darkMode = !state.darkMode;
            GM_setValue('darkMode', state.darkMode);
            this.innerHTML = state.darkMode ? '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>' : '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
            this.title = state.darkMode ? 'Ativar Modo Claro' : 'Ativar Modo Escuro';
            aplicarTema(true);
            adicionarLog('Tema ' + (state.darkMode ? 'escuro' : 'claro') + ' ativado via atalho', 'info');
        });

        bindEl('eproc-btn-fechar', 'onclick', function () {
            var d = document.getElementById('eproc-dashboard');
            d.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
            d.style.opacity = '0';
            d.style.transform = 'scale(0.92)';
            setTimeout(function () {
                state.viewMode = 'minimized';
                d.classList.remove('show', 'compact', 'maximized');
                d.style.opacity = '';
                d.style.transform = '';
                d.style.transition = '';
                miniBtn.style.display = 'flex';
            }, 260);
        });

        bindEl('eproc-btn-viewmode', 'onclick', function () {
            var d = document.getElementById('eproc-dashboard');
            var rect = d.getBoundingClientRect();
            state.compactMode = !state.compactMode;
            var themeClass = (!state.darkMode ? ' light-mode' : '');
            if (state.compactMode) {
                d.style.left = rect.left + 'px';
                d.style.top = rect.top + 'px';
                d.style.right = 'auto';
                d.style.bottom = 'auto';
                d.className = 'compact show' + themeClass;
                this.title = 'Maximizar';
            } else {
                d.style.left = rect.left + 'px';
                d.style.top = rect.top + 'px';
                d.style.right = 'auto';
                d.style.bottom = 'auto';
                d.className = 'maximized show' + themeClass;
                this.title = 'Minimizar';
            }
            requestAnimationFrame(function () {
                d.style.left = '';
                d.style.top = '';
                d.style.right = '';
                d.style.bottom = '';
                d.className = (state.compactMode ? 'compact' : 'maximized') + ' show' + themeClass;
                aplicarTema(false);

                setTimeout(function () {
                    if (state.dadosFiltrados && state.dadosFiltrados.length > 0) {
                        renderDashboard();
                    }
                }, 150);
            });
        });

        var procTimer;
        bindEl('eproc-filtro-processo', 'oninput', function () {
            clearTimeout(procTimer);
            var val = this.value;
            procTimer = setTimeout(function () {
                state.filters.processo = val.replace(/[.\-]/g, '').trim().toLowerCase();
                if (state.dadosFiltrados) renderDashboard();
            }, 300);
        });

        // Tab switching
        (function() {
            var tabs = document.querySelectorAll('#eproc-dashboard .tab-btn');
            tabs.forEach(function (btn) {
                btn.onclick = function () {
                    var tab = this.dataset.tab;
                    tabs.forEach(function (b) { b.classList.remove('active'); });
                    this.classList.add('active');
                    document.querySelectorAll('#eproc-dashboard .tab-content').forEach(function (c) {
                        c.classList.remove('active');
                    });
                    document.getElementById('tab-' + tab).classList.add('active');
                    state.tabAtiva = tab;

                    if (tab === 'relatorios') {
                        abrirAbaRelatorios();
                    }
                };
            });
        })();

        // Drag header
        bindEl('eproc-dash-header', 'onmousedown', iniciarArrasto);
        document.addEventListener('mousemove', function (e) {
            if (!state.arrastando) return;
            var d = document.getElementById('eproc-dashboard');
            if (state.compactMode) {
                d.style.left = (e.clientX - state.arrastoOffX) + 'px';
                d.style.top = (e.clientY - state.arrastoOffY) + 'px';
                d.style.right = 'auto';
                d.style.bottom = 'auto';
            }
        });
        document.addEventListener('mouseup', function () {
            state.arrastando = false;
        });

        // Tab 1 buttons
        bindEl('eproc-btn-importar', 'onclick', onClickImportar);

        // Stats tooltip
        var statsArea = document.getElementById('eproc-stats-area');
        if (statsArea) {
            statsArea.onmouseenter = mostrarTooltip;
            statsArea.onmouseleave = function () {
                var tip = document.getElementById('eproc-tooltip');
                if (tip) tip.style.display = 'none';
            };
        } else {
            adicionarLog('§ BIND FALHOU: #eproc-stats-area n\u00e3o encontrado', 'error');
        }

        // Tabela & modal de historico
        bindEl('eproc-pl-close', 'onclick', function () {
            document.getElementById('eproc-processos-overlay').classList.remove('active');
        });
        
        var histInput = document.getElementById('eproc-hist-input');
        var histSearch = document.getElementById('eproc-hist-search');
        var btnHistProc = document.getElementById('eproc-btn-hist-proc');

        if (btnHistProc && histInput && histSearch) {
            btnHistProc.onclick = function() {
                var showing = histInput.style.display !== 'none';
                histInput.style.display = showing ? 'none' : 'inline-block';
                histSearch.style.display = showing ? 'none' : 'inline-block';
                if (!showing) {
                    histInput.value = '';
                    histInput.focus();
                }
            };
        } else {
            adicionarLog('§ BIND FALHOU: #eproc-btn-hist-proc e dependentes', 'error');
        }
        bindEl('eproc-hist-close', 'onclick', function() {
            var o = document.getElementById('eproc-hist-overlay');
            if (o) o.classList.remove('active');
        });
        bindEl('eproc-hist-search', 'onclick', buscarHistoricoProcessoInline);
        (function() {
            var el = document.getElementById('eproc-hist-input');
            if (el) {
                el.addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') buscarHistoricoProcessoInline();
                });
            }
        })();

        // Footer buttons

        // Footer buttons
        bindEl('eproc-btn-export-json', 'onclick', function() {
            if (!state.dadosBrutos) { alert('Nenhum dado para exportar.'); return; }
            var blob = new Blob([JSON.stringify(state.dadosBrutos, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'eproc-dados-export-' + hojeISO() + '.json';
            a.click();
            URL.revokeObjectURL(url);
        });
        bindEl('eproc-btn-import-json', 'onclick', function() {
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = function(e) {
                var file = e.target.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function(ev) {
                    try {
                        var imported = JSON.parse(ev.target.result);
                        if (!imported || !imported.logs) { alert('Arquivo inválido.'); return; }
                        if (!state.dadosBrutos) {
                            state.dadosBrutos = imported;
                        } else {
                            var idsExistentes = new Set((state.dadosBrutos.logs || []).map(function(l) { return l[0]; }));
                            (imported.logs || []).forEach(function(l) {
                                if (!idsExistentes.has(l[0])) {
                                    state.dadosBrutos.logs.push(l);
                                    idsExistentes.add(l[0]);
                                }
                            });
                            var regrasExistentes = new Set((state.dadosBrutos.regras || []).map(function(r) { return r[0]; }));
                            (imported.regras || []).forEach(function(r) {
                                if (!regrasExistentes.has(r[0])) {
                                    state.dadosBrutos.regras.push(r);
                                    regrasExistentes.add(r[0]);
                                }
                            });
                        }
                        processarDadosHelper(state.dadosBrutos);
                        if (state.tabAtiva === 'relatorios') mostrarDashboard();
                        adicionarLog('Dados importados: ' + (imported.logs || []).length + ' logs', 'success');
                    } catch (err) {
                        alert('Erro ao importar: ' + err.message);
                    }
                };
                reader.readAsText(file);
            };
            input.click();
        });
        bindEl('eproc-btn-limpar-base', 'onclick', function() {
            if (confirm('Tem certeza que deseja limpar toda a base de logs local?')) {
                state.dadosBrutos = null;
                if (PERFIL_ATUAL) GM_setValue('ultimaExtracao_' + PERFIL_ATUAL, null);
                GM_setValue('eprocLogsRawData', null); // ou o banco supabase
                alert('Base local limpa.');
                location.reload();
            }
        });

        // ---- BIND DASHBOARD FILTERS ----
        bindEl('eproc-btn-limpar', 'onclick', limparFiltros);
        bindEl('eproc-filtro-data-inicio', 'onchange', aplicarFiltrosEAplicar);
        bindEl('eproc-filtro-data-fim', 'onchange', aplicarFiltrosEAplicar);
        rebindFiltros();

        // Date presets
        (function() {
            var els = document.querySelectorAll('#eproc-date-presets span');
            if (!els.length) { adicionarLog('§ BIND FALHOU: "#eproc-date-presets span" sem matches', 'error'); return; }
            els.forEach(function (el) {
                el.onclick = function () {
                    document.querySelectorAll('#eproc-date-presets span').forEach(function (s) { s.classList.remove('active'); });
                    this.classList.add('active');
                    aplicarPresetData(this.dataset.preset);
                };
            });
        })();

        // Metrica toggle
        (function() {
            var el = document.getElementById('eproc-metrica-toggle');
            if (el) {
                el.onclick = function () {
                    state.metricaAtiva = (state.metricaAtiva === 'processos') ? 'execucoes' : 'processos';
                    atualizarBotaoMetrica();
                    if (state.dadosFiltrados) {
                        renderDashboard();
                    }
                };
            } else {
                adicionarLog('§ BIND FALHOU: #eproc-metrica-toggle n\u00e3o encontrado', 'error');
            }
        })();

        // Order toggle
        bindAll('.fs-ord-toggle span', 'onclick', function () {
            document.querySelectorAll('.fs-ord-toggle span').forEach(function (s) { s.classList.remove('active'); });
            this.classList.add('active');
            state.filters.ordenacao = this.dataset.ordem;
            if (state.dadosFiltrados) renderDashboard();
        });

        // Pie dimension buttons
        bindAll('#pie-dims span', 'onclick', function () {
            document.querySelectorAll('#pie-dims span').forEach(function (s) { s.classList.remove('active'); });
            this.classList.add('active');
            state.filters.pieDimensao = this.dataset.dim;
            if (state.dadosFiltrados) renderDashboard();
        });

        // Glossary select
        bindEl('eproc-glossario-select', 'onchange', function () {
            mostrarGlossario(this.value);
        });

        // Table search
        bindEl('eproc-tabela-busca', 'oninput', function () {
            renderTabela(state.dadosFiltrados);
        });

        // Table sort
        (function() {
            var els = document.querySelectorAll('#eproc-data-table thead th');
            if (!els.length) { adicionarLog('§ BIND FALHOU: "#eproc-data-table thead th" sem matches', 'error'); return; }
            els.forEach(function (th) {
            th.onclick = function () {
                var sortKey = this.dataset.sort;
                if (!sortKey) return;
                if (state.tabelaSortDir === sortKey) {
                    state.tabelaSortDirAsc = !state.tabelaSortDirAsc;
                } else {
                    state.tabelaSortDirAsc = true;
                    state.tabelaSortDir = sortKey;
                }
                state.tabelaSort = sortKey;
                renderTabela(state.dadosFiltrados);
            };
            });
        })();

        // XLSX button
        bindEl('eproc-btn-xlsx', 'onclick', exportarXLSX);

        // Processos button (replaces overlay version)
        bindEl('eproc-btn-processos', 'onclick', function () {
            var overlay = document.getElementById('eproc-processos-overlay');
            if (overlay && overlay.classList.contains('active')) {
                state.exibirProcessos = false;
                this.classList.remove('active');
                overlay.classList.remove('active');
            } else {
                state.exibirProcessos = true;
                this.classList.add('active');
                if (state.dadosFiltrados) {
                    abrirListaProcessos();
                }
            }
        });
        bindAll('.btn-chart-png', 'onclick', function () {
            baixarChartPNG(this.dataset.chart);
        });

        // Retry button
        bindEl('eproc-rel-retry', 'onclick', function () {
            buscarDadosAPI(true);
        });

        // Botão de atualizar manual no topo da aba Relatórios
        bindEl('eproc-btn-sync-manual', 'onclick', function () {
            buscarDadosAPI(true);
        });

        // Delegação de clique para visualizar processos da linha cronologicamente (+x)
        bindEl('eproc-table-body', 'onclick', function (e) {
            var target = e.target;
            if (target && target.classList.contains('ver-mais-processos')) {
                var regra = target.dataset.regra;
                var chave = regra;
                if (state.tabelaAgregada && state.tabelaAgregada[chave]) {
                    var linha = state.tabelaAgregada[chave];
                    abrirListaProcessosDaLinha(linha.regra, linha.processos);
                }
            }
        });

        // Extrair dados - auto search
        var n = extrairRegras().length;
        adicionarLog(n + ' regras encontradas na pagina', 'info');
        if (n > 0) atualizarBadgeExtracao();

        // Inicializa ícone do tema de acordo com state.darkMode
        var themeBtn = document.getElementById('eproc-btn-theme');
        if (themeBtn) {
            themeBtn.innerHTML = state.darkMode ? '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>' : '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
            themeBtn.title = state.darkMode ? 'Ativar Modo Claro' : 'Ativar Modo Escuro';
        }

        // Aplicar tema padrão ao final da criação de todos os elementos
        aplicarTema(false);
    }

    // ================================================================
    // DRAG
    // ================================================================
    function iniciarArrasto(e) {
        if (e.target.closest('.hactions')) return;
        if (!state.compactMode) return;
        state.arrastando = true;
        var d = document.getElementById('eproc-dashboard');
        var rect = d.getBoundingClientRect();
        state.arrastoOffX = e.clientX - rect.left;
        state.arrastoOffY = e.clientY - rect.top;
        d.style.right = 'auto';
        d.style.left = rect.left + 'px';
        d.style.top = rect.top + 'px';
        e.preventDefault();
    }

    // ================================================================
    // STATUS BADGE
    // ================================================================
    function atualizarStatusExtracao() {
        if (!PERFIL_ATUAL) return 'desatualizado';
        var ultima = state.ultimaExtracao;
        if (!ultima) return 'desatualizado';
        var agora = new Date();
        var ult = new Date(ultima);
        var diffMin = (agora - ult) / 60000;
        return diffMin < 30 ? 'ativos' : 'desatualizado';
    }

    function atualizarBadgeExtracao() {
        var badge = document.getElementById('eproc-status-badge');
        if (!badge) return;
        var cls = atualizarStatusExtracao();
        badge.className = 'status-badge ' + cls;
        badge.textContent = cls === 'ativos' ? 'Atualizado' : 'Desatualizado';
    }

    // ================================================================
    // TOGGLE PAUSA
    // ================================================================
    function onClickImportar() {
        if (!state.processando) {
            iniciarImportacao();
            return;
        }
        state.pausado = !state.pausado;
        var btn = document.getElementById('eproc-btn-importar');
        if (state.pausado) {
            btn.textContent = '▶ Continuar';
            btn.className = 'success';
            adicionarLog('⏸ PAUSADO', 'warn');
        } else {
            btn.textContent = '⏸ Pausar';
            btn.className = 'primary';
            adicionarLog('▶ Continuando', 'success');
            if (state.resumeResolver) { state.resumeResolver(); state.resumeResolver = null; }
        }
    }

    function aguardarResume() {
        if (!state.pausado) return Promise.resolve();
        return new Promise(function (resolve) {
            state.resumeResolver = resolve;
        });
    }

    // ================================================================
    // TOOLTIP
    // ================================================================
    function mostrarTooltip() {
        var tt = document.getElementById('eproc-tooltip');
        var keys = Object.keys(state.stats.porRegra);
        if (keys.length === 0) { tt.style.display = 'none'; return; }
        tt.innerHTML = keys.sort(function (a, b) {
            return parseInt(a) - parseInt(b);
        }).map(function (k) {
            return '<div class="tt-row"><span class="tt-label">Regra ' + k + '</span>' +
                '<span class="tt-value">' + state.stats.porRegra[k] + ' logs</span></div>';
        }).join('');
        tt.style.display = 'block';
    }

    // ================================================================
    // UI UPDATE (extraction)
    // ================================================================
    function atualizarUI() {
        var total = state.stats.regrasTotal || state.regrasPendentes.length;
        var eRegras = document.getElementById('eproc-stat-regras');
        var eExtraidos = document.getElementById('eproc-stat-extraidos');
        var eNovos = document.getElementById('eproc-stat-novos');
        var eIgnorados = document.getElementById('eproc-stat-ignorados');
        var eDuplicados = document.getElementById('eproc-stat-duplicados');
        var eErros = document.getElementById('eproc-stat-erros');
        var eErrosFetch = document.getElementById('eproc-stat-erros-fetch');
        var eErrosFlush = document.getElementById('eproc-stat-erros-flush');
        var eEta = document.getElementById('eproc-stat-eta');
        var eBar = document.getElementById('eproc-bar');
        if (eRegras) eRegras.textContent = state.stats.regrasProcessadas + ' / ' + total;
        if (eExtraidos) eExtraidos.textContent = state.stats.logsExtraidos;
        if (eNovos) eNovos.textContent = state.stats.logsNovos;
        if (eIgnorados) eIgnorados.textContent = state.stats.logsIgnorados;
        if (eDuplicados) eDuplicados.textContent = state.stats.logsDuplicados;
        if (eErros) eErros.textContent = state.stats.erros;
        if (eErrosFetch) eErrosFetch.textContent = state.stats.errosFetch;
        if (eErrosFlush) eErrosFlush.textContent = state.stats.errosFlush;
        if (eEta && state.stats.regrasProcessadas > 0 && state.stats.regrasProcessadas < total) {
            var media = state.stats.temposRegra.reduce(function (a, b) { return a + b; }, 0) / state.stats.temposRegra.length;
            var restantes = total - state.stats.regrasProcessadas;
            eEta.textContent = fmtTempo(media * restantes);
        } else if (eEta) {
            eEta.textContent = state.stats.regrasProcessadas >= total ? '00:00' : '--:--';
        }
        if (eBar) {
            var pct = total > 0 ? Math.round(state.stats.regrasProcessadas / total * 100) : 0;
            eBar.style.width = pct + '%';
        }
    }

    // ================================================================
    // SUPABASE - EXTRACTION
    // ================================================================
    async function enviarParaSupabase(logs) {
        if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
            throw new Error('Supabase nao configurado');
        }

        adicionarLog('Sincronizando ' + logs.length + ' registros...', 'info');
        var payload = logsToSupabase(logs);

        try {
            // ?on_conflict=id instrui o PostgREST a comparar pelo ID (Upsert)
            // noMerge: false ativa o header 'Prefer: resolution=merge-duplicates'
            // Isso elimina erros 409 e garante que duplicados sejam ignorados/atualizados pelo banco
            await supabaseRest('/rest/v1/logs?on_conflict=id', {
                method: 'POST',
                data: payload,
                noMerge: false,
                timeout: 60000
            });

            adicionarLog('Sucesso: Batch de ' + logs.length + ' processado (Upsert).', 'success');
            return { novos: logs.length, ignorados: 0 };
        } catch (e) {
            adicionarLog('Erro na sincronizacao: ' + e.message, 'error');
            throw e;
        }
    }

    async function flushBuffer() {
        if (state.logsBuffer.length === 0) return;
        var batch = state.logsBuffer.splice(0, CONFIG.batchSize);
        if (state.retryBatch.dados && state.retryBatch.dados === batch) {
            state.retryBatch.contador++;
        } else {
            state.retryBatch = { contador: 0, dados: batch };
        }
        if (state.retryBatch.contador >= 5) {
            adicionarLog('FALHA flush apos ' + state.retryBatch.contador + ' tentativas: ' + batch.length + ' registros perdidos', 'error');
            state.stats.errosFlush++; state.stats.erros++;
            state.retryBatch.dados = null;
            atualizarUI();
            return;
        }
        adicionarLog('Flush: ' + batch.length + ' regs (buf=' + state.logsBuffer.length + ')', 'info');
        try {
            var resp = await enviarParaSupabase(batch);
            state.stats.logsNovos += resp.novos || 0;
            state.stats.logsIgnorados += resp.ignorados || 0;
            state.retryBatch.dados = null;
            atualizarUI();
        } catch (err) {
            state.stats.errosFlush++; state.stats.erros++; atualizarUI();
            adicionarLog('FALHA flush (tentativa ' + (state.retryBatch.contador + 1) + '/5): ' + err.message, 'error');
            state.logsBuffer = batch.concat(state.logsBuffer);
        }
    }

    // ================================================================
    // PARSING (existing preserved)
    // ================================================================
    function parseLogRows(html, numRegra, codRegra) {
        var rows = [];
        var tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
        if (!tbodyMatch) return rows;

        var theadMatch = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
        var procIdx = 0, dataIdx = 1;
        if (theadMatch) {
            var thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi, thM, idx = 0;
            while ((thM = thRegex.exec(theadMatch[1])) !== null) {
                var txt = thM[1].replace(/<[^>]+>/g, '').toLowerCase().trim();
                if (txt.indexOf('processo') !== -1) procIdx = idx;
                else if (txt.indexOf('data') !== -1) dataIdx = idx;
                idx++;
            }
        }

        var trRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi, m;
        while ((m = trRegex.exec(tbodyMatch[1])) !== null) {
            var tds = m[0].match(/<td[^>]*>[\s\S]*?<\/td>/gi);
            if (!tds || tds.length <= Math.max(procIdx, dataIdx)) continue;

            // Extrai link real do <a> e texto do processo
            var aMatch = tds[procIdx].match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
            var proc = '', procUrl = '';
            if (aMatch) {
                proc = aMatch[2].replace(/<[^>]+>/g, '').trim();
                var urlDec = aMatch[1].replace(/&amp;/g, '&');
                procUrl = urlDec.indexOf('http') === 0 ? urlDec :
                    'https://eproc1g.tjmg.jus.br/eproc/' + urlDec;
            } else {
                proc = tds[procIdx].replace(/<[^>]+>/g, '').trim();
            }

            // data completa "DD/MM/YYYY HH:mm:ss" — mantida para hash
            var dataCompleta = tds[dataIdx].replace(/<[^>]+>/g, '').trim();
            var dataOnly = '', horaOnly = '';
            var esp = dataCompleta.match(/^(\S+)\s+(\S+)/);
            if (esp) { dataOnly = esp[1]; horaOnly = esp[2]; } else { dataOnly = dataCompleta; }

            if (proc && dataCompleta) rows.push({
                processo: proc,
                processoUrl: procUrl,
                data: dataCompleta,   // full datetime (hash compat)
                dataOnly: dataOnly,   // just date for sheet
                hora: horaOnly,       // just time for sheet
                regra: numRegra,
                codRegra: codRegra
            });
        }
        return rows;
    }

    function extrairInfoPaginacao(html) {
        var m = html.match(/Mostrando de \d+ at[eé] (\d+) de (\d+) registros/i);
        return m ? { rowsPerPage: parseInt(m[1]), totalRecords: parseInt(m[2]) } : null;
    }

    async function fetchLogsRegra(urlLog, numRegra, codRegra) {
        var ultimoErro = null;
        try {
            var logs = await tentarPostForm(urlLog, numRegra, codRegra);
            if (logs.length > 0) return logs;
        } catch (e) { ultimoErro = e; adicionarLog('R' + numRegra + ' POST=' + e.message, 'warn'); }
        try {
            var r = await fetch(urlLog, { credentials: 'include' });
            var logs = parseLogRows(await r.text(), numRegra, codRegra);
            if (logs.length > 0) return logs;
        } catch (e) { ultimoErro = e; adicionarLog('R' + numRegra + ' GET=' + e.message, 'warn'); }
        if (ultimoErro) throw new Error('Falha ao extrair regra ' + numRegra + ': ' + ultimoErro.message);
        return [];
    }

    function extrairParamsUrl(url) {
        var p = {}, m;
        m = url.match(/id_controle_localizador_sistema=([^&]+)/); if (m) p.id_controle = m[1];
        m = url.match(/cod_controle_localizador_sistema=([^&]+)/); if (m) p.cod_controle = m[1];
        m = url.match(/num_regra=([^&]+)/); if (m) p.num_regra = m[1];
        m = url.match(/hash=([^&]+)/); if (m) p.hash = m[1];
        return p;
    }

    async function tentarPostForm(urlLog, numRegra, codRegra) {
        var p = extrairParamsUrl(urlLog);
        var todosLogs = [];
        var start = 0;
        var totalRecords = Infinity;
        while (start < totalRecords) {
            var fd = new URLSearchParams();
            if (p.id_controle) fd.set('hdnIdControleLocalizadorSistema', p.id_controle);
            if (p.cod_controle) fd.set('hdnCodControleLocalizadorSistema', p.cod_controle);
            if (p.num_regra) fd.set('hdnNumRegra', p.num_regra);
            fd.set('hdnNumIdOrgao', '284');
            fd.set('tableAutomatizacaoLocalizadoresLog_length', '9999');
            fd.set('start', String(start));
            var r = await fetch(urlLog, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: fd.toString()
            });
            var html = await r.text();
            var logs = parseLogRows(html, numRegra, codRegra);
            if (logs.length === 0) break;
            todosLogs = todosLogs.concat(logs);
            var infoPad = extrairInfoPaginacao(html);
            if (infoPad) totalRecords = infoPad.totalRecords;
            start += logs.length;
            if (start >= totalRecords) break;
            if (logs.length < 9999) break;
        }
        return todosLogs;
    }

    function extrairRegras() {
        if (typeof jQuery === 'undefined') { adicionarLog('jQuery nao disponivel', 'error'); return []; }
        var regras = [];

        var colMap = { regra: 1, grupo: 2, origem: 3, controle: 4, destino: 5, outros: 6, acoes: 7 };
        $('#tableAutomatizacaoLocalizadores thead th').each(function (idx) {
            var txt = $(this).text().toLowerCase().trim();
            if (txt.indexOf('nº') !== -1 || txt.indexOf('prioridade') !== -1 || txt.indexOf('regra') !== -1) colMap.regra = idx;
            else if (txt.indexOf('grupo') !== -1) colMap.grupo = idx;
            else if (txt.indexOf('origem') !== -1) colMap.origem = idx;
            else if (txt.indexOf('destino') !== -1 || txt.indexOf('ação') !== -1 || txt.indexOf('acao') !== -1) colMap.destino = idx;
            else if (txt.indexOf('outros') !== -1) colMap.outros = idx;
            else if (txt.indexOf('controle') !== -1 || txt.indexOf('critério') !== -1 || txt.indexOf('criterio') !== -1) colMap.controle = idx;
            else if (txt.indexOf('ações') !== -1 || txt.indexOf('acoes') !== -1) colMap.acoes = idx;
        });

        $('#tableAutomatizacaoLocalizadores tbody tr').each(function () {
            var $tds = $(this).find('td');
            if ($tds.length < 5) return;

            var getTd = function (key) { return $tds.eq(colMap[key]) && $tds.eq(colMap[key]).length ? $tds.eq(colMap[key]) : $tds.eq(0); };

            var $tdRegra = getTd('regra');
            var numRegra = $tdRegra.find('span[style*="underline"]').text().trim();
            if (!numRegra) numRegra = $tdRegra.text().trim();

            // Extrai grupo da coluna mapeada com extrema resiliência (ignora dropdowns e botões de ação)
            var $tdGrupo = getTd('grupo');
            var $clone = $tdGrupo.clone();

            // 1. Remove qualquer <select> ou <option>, pois contêm os menus "== ALTERAR ==" que corrompem a leitura
            $clone.find('select, option').remove();

            // 2. Remove tags que sejam puramente botões de edição como "[+]"
            $clone.find('a, button, span').each(function () {
                var t = $(this).text().trim();
                if (t === '[+]' || t.indexOf('==') !== -1) {
                    $(this).remove();
                }
            });

            // 3. Pega o texto limpo restante
            var grupoRaw = $clone.text()
                .replace(/==.*?==/g, '') // redundância
                .replace(/\[\+\]/g, '')  // redundância
                .replace(/[\r\n\t]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            var grupo = (grupoRaw !== '') ? grupoRaw : 'Não Classificado';

            var origem = getTd('origem').text().trim();
            var controle = getTd('controle').text().trim();
            var destino = getTd('destino').text().trim();
            var outros = getTd('outros').text().trim();

            var $tdAcoes = getTd('acoes');
            var $lk = $tdAcoes.find('a').filter(function () {
                return $(this).find('i[title="Consultar"],i[alt="Consultar"],i.material-icons:contains("search")').length > 0;
            }).first();

            if (!$lk.length) $lk = $tdAcoes.find('a[href*="log_por_regra"]').first();

            if (!$lk.length) {
                // Extrema resiliência: procura o link de consultar em qualquer lugar da linha caso não ache na coluna designada
                $lk = $(this).find('a').filter(function () {
                    var h = $(this).attr('href') || '';
                    return h.indexOf('log_por_regra') !== -1;
                }).first();
            }

            var href = $lk.attr('href');
            if (!href || !numRegra) return;
            var cod = href.match(/cod_controle_localizador_sistema=(\d+)/);
            regras.push({
                numRegra: numRegra,
                grupo: grupo,
                origem: origem,
                controle: controle,
                destino: destino,
                outros: outros,
                codRegra: cod ? cod[1] : '',
                urlLog: href.indexOf('http') === 0 ? href : 'https://eproc1g.tjmg.jus.br/eproc/' + href
            });
        });
        return regras;
    }

    async function syncAutomatizacoes(regras) {
        adicionarLog('Sincronizando ' + regras.length + ' regras...', 'info');
        var data = regrasToSupabase(regras);
        var chunkSize = 1000;
        for (var i = 0; i < regras.length; i += chunkSize) {
            var chunk = data.slice(i, i + chunkSize);
            await supabasePost('regras', chunk);
        }
        adicionarLog('Regras sincronizadas com sucesso.', 'success');
        return true;
    }

    // ================================================================
    // EXTRACAO MULTI-PAGINA DE REGRAS
    // Busca todas as regras independentemente da paginação atual da tabela
    // ================================================================
    async function extrairTodasRegras() {
        // Primeiro tenta extrair da página atual
        var regrasLocais = extrairRegras();

        // Detecta o total de regras via info de paginação do DataTables (EPROC)
        var totalInfo = document.getElementById('tableAutomatizacaoLocalizadores_info');
        var totalRegras = 0;
        if (totalInfo) {
            var infoText = totalInfo.textContent || '';
            var mTotal = infoText.match(/(\d[\d.]*) (registro|entr|result)/i);
            if (mTotal) totalRegras = parseInt(mTotal[1].replace(/\./g, ''));
        }

        // Se não encontrou info de total, ou já temos todas as regras, retorna o que extraiu
        if (totalRegras <= regrasLocais.length || totalRegras === 0) {
            adicionarLog('Regras locais: ' + regrasLocais.length + ' (pagina atual)', 'info');
            return regrasLocais;
        }

        adicionarLog('Total de regras detectado: ' + totalRegras + ' | Pagina atual: ' + regrasLocais.length + '. Buscando demais paginas...', 'warn');

        // Monta a URL base da página atual para buscar outras páginas via POST (DataTables AJAX)
        var todasRegras = regrasLocais.slice();
        var urlAtual = window.location.href;
        var paginaSize = regrasLocais.length || 50;
        var start = paginaSize;

        // Tenta buscar páginas adicionais via DataTables (EPROC usa DataTables com server-side)
        while (todasRegras.length < totalRegras) {
            try {
                adicionarLog('Buscando pagina adicional (start=' + start + ')...', 'info');
                var fd = new URLSearchParams();
                fd.set('acao', 'automatizar_localizadores');
                fd.set('tableAutomatizacaoLocalizadores_length', String(paginaSize));
                fd.set('start', String(start));

                var r = await fetch(urlAtual, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: fd.toString()
                });
                var html = await r.text();

                // Injeta o HTML em um iframe temporário para parsear com jQuery
                var parser = new DOMParser();
                var doc = parser.parseFromString(html, 'text/html');
                var tbody = doc.querySelector('#tableAutomatizacaoLocalizadores tbody');
                if (!tbody || !tbody.querySelectorAll('tr').length) break;

                // Extrai regras do HTML parseado usando a mesma lógica de extrairRegras
                var regrasExtra = extrairRegrasDeDOM(doc);
                if (regrasExtra.length === 0) break;

                todasRegras = todasRegras.concat(regrasExtra);
                start += regrasExtra.length;
                adicionarLog('Pagina adicional: +' + regrasExtra.length + ' regras (total=' + todasRegras.length + ')', 'info');

                if (regrasExtra.length < paginaSize) break;
            } catch (e) {
                adicionarLog('Erro ao buscar pagina adicional: ' + e.message + '. Prosseguindo com ' + todasRegras.length + ' regras.', 'warn');
                break;
            }
        }

        adicionarLog('Total de regras coletadas: ' + todasRegras.length, 'success');
        return todasRegras;
    }

    // Versão de extrairRegras que opera sobre um Document externo (para multi-página)
    function extrairRegrasDeDOM(doc) {
        var regras = [];
        var colMap = { regra: 1, grupo: 2, origem: 3, controle: 4, destino: 5, outros: 6, acoes: 7 };
        var thead = doc.querySelectorAll('#tableAutomatizacaoLocalizadores thead th');
        thead.forEach(function (th, idx) {
            var txt = (th.textContent || '').toLowerCase().trim();
            if (txt.indexOf('nº') !== -1 || txt.indexOf('prioridade') !== -1 || txt.indexOf('regra') !== -1) colMap.regra = idx;
            else if (txt.indexOf('grupo') !== -1) colMap.grupo = idx;
            else if (txt.indexOf('origem') !== -1) colMap.origem = idx;
            else if (txt.indexOf('destino') !== -1 || txt.indexOf('ação') !== -1 || txt.indexOf('acao') !== -1) colMap.destino = idx;
            else if (txt.indexOf('outros') !== -1) colMap.outros = idx;
            else if (txt.indexOf('controle') !== -1 || txt.indexOf('critério') !== -1 || txt.indexOf('criterio') !== -1) colMap.controle = idx;
            else if (txt.indexOf('ações') !== -1 || txt.indexOf('acoes') !== -1) colMap.acoes = idx;
        });
        var rows = doc.querySelectorAll('#tableAutomatizacaoLocalizadores tbody tr');
        rows.forEach(function (tr) {
            var tds = tr.querySelectorAll('td');
            if (tds.length < 5) return;
            var getTd = function (key) { return tds[colMap[key]] || tds[0]; };
            var tdRegra = getTd('regra');
            var spanRegra = tdRegra.querySelector('span[style*="underline"]');
            var numRegra = spanRegra ? spanRegra.textContent.trim() : tdRegra.textContent.trim();
            var tdAcoes = getTd('acoes');
            var links = tdAcoes.querySelectorAll('a');
            var lk = null;
            links.forEach(function (a) {
                var href = a.getAttribute('href') || '';
                if (href.indexOf('log_por_regra') !== -1) lk = a;
            });
            if (!lk) {
                tr.querySelectorAll('a').forEach(function (a) {
                    var href = a.getAttribute('href') || '';
                    if (href.indexOf('log_por_regra') !== -1) lk = a;
                });
            }
            var href = lk ? lk.getAttribute('href') : null;
            if (!href || !numRegra) return;
            var tdGrupo = getTd('grupo');
            var grupoClone = tdGrupo.cloneNode(true);
            grupoClone.querySelectorAll('select, option, a, button').forEach(function (el) { el.parentNode.removeChild(el); });
            var grupoRaw = (grupoClone.textContent || '').replace(/==.*?==/g, '').replace(/\[\+\]/g, '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
            var cod = href.match(/cod_controle_localizador_sistema=(\d+)/);
            regras.push({
                numRegra: numRegra,
                grupo: grupoRaw || 'Não Classificado',
                origem: getTd('origem').textContent.trim(),
                controle: getTd('controle').textContent.trim(),
                destino: getTd('destino').textContent.trim(),
                outros: getTd('outros').textContent.trim(),
                codRegra: cod ? cod[1] : '',
                urlLog: href.indexOf('http') === 0 ? href : 'https://eproc1g.tjmg.jus.br/eproc/' + href
            });
        });
        return regras;
    }

    // ================================================================
    // IMPORTACAO (existing, adapted)
    // ================================================================
    async function iniciarImportacao() {
        if (state.processando) { adicionarLog('Ja processando', 'warn'); return; }
        state.processando = true; state.pausado = false;
        var btn = document.getElementById('eproc-btn-importar');
        if (!state.silentMode) {
            btn.textContent = '⏸ Pausar';
            btn.className = 'primary';
        }
        adicionarLog('=== INICIANDO IMPORTACAO ===', 'success');
        if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) { adicionarLog('Configure o Supabase!', 'error'); state.processando = false; state.silentMode = false; if (!state.silentMode) { btn.textContent = '▶ Importar Logs'; btn.className = 'primary'; } return; }

        // Extrai TODAS as regras (multi-página automático)
        adicionarLog('Buscando todas as regras (multi-pagina)...', 'info');
        var regras = await extrairTodasRegras();
        if (regras.length === 0) { adicionarLog('Nenhuma regra!', 'error'); state.processando = false; state.silentMode = false; if (!state.silentMode) { btn.textContent = '▶ Importar Logs'; btn.className = 'primary'; } return; }
        state.stats.regrasTotal = regras.length;
        state.stats.regrasProcessadas = 0;
        state.stats.logsExtraidos = 0; state.stats.logsNovos = 0; state.stats.logsIgnorados = 0; state.stats.logsDuplicados = 0; state.stats.erros = 0; state.stats.errosFetch = 0; state.stats.errosFlush = 0;
        state.stats.inicio = Date.now(); state.stats.temposRegra = []; state.stats.porRegra = {};
        state.regrasPendentes = regras.slice();
        state.idsEnviados = new Set();
        // OTIMIZACAO DE MEMORIA: Removido carregamento de IDs existentes do Supabase.
        // O banco de dados agora e o porteiro final via Primary Key (Upsert on_conflict=id).
        // Isso elimina o crescimento de RAM proporcional ao volume do banco.
        state.logsBuffer = [];
        atualizarUI();

        adicionarLog(regras.length + ' regras encontradas (todas as paginas)', 'info');
        try { await syncAutomatizacoes(regras); }
        catch (e) { adicionarLog('Erro sync regras: ' + e.message, 'error'); }
        for (var i = 0; i < regras.length; i++) {
            if (i >= CONFIG.maxRegrasPorExecucao) { adicionarLog('Limite atingido', 'warn'); break; }
            await aguardarResume();
            var regra = regras[i];
            var t0 = Date.now();
            adicionarLog('[' + (i + 1) + '/' + regras.length + '] R' + regra.numRegra, 'info');
            try {
                var logs = await fetchLogsRegra(regra.urlLog, regra.numRegra, regra.codRegra);
                state.stats.logsExtraidos += logs.length;
                if (logs.length > 0) state.stats.porRegra[regra.numRegra] = logs.length;
                for (var li = 0; li < logs.length; li++) {
                    var log = logs[li];
                    var id = await md5(log.processo + '|' + log.data + '|' + log.regra);
                    // Apenas verifica duplicados na sessão atual (RAM constante)
                    // Duplicados do banco são tratados pelo Upsert (on_conflict=id)
                    if (!state.idsEnviados.has(id)) {
                        log.id = id; state.logsBuffer.push(log); state.idsEnviados.add(id);
                    } else {
                        state.stats.logsDuplicados++;
                    }
                }
                if (state.logsBuffer.length >= CONFIG.batchSize) await flushBuffer();
            } catch (err) {
                state.stats.errosFetch++; state.stats.erros++;
                atualizarUI();
                adicionarLog('R' + regra.numRegra + ' ERRO: ' + err.message, 'error');
            }
            state.stats.temposRegra.push(Date.now() - t0);
            state.stats.regrasProcessadas++;
            atualizarUI();
        }
        if (state.logsBuffer.length > 0) await flushBuffer();
        var elapsed = fmtTempo(Date.now() - state.stats.inicio);
        adicionarLog('=== CONCLUIDO (' + elapsed + ') ===', 'success');
        adicionarLog('Extraidos: ' + state.stats.logsExtraidos + ' | Enviados: ' + state.stats.logsNovos +
            ' | Ignorados: ' + state.stats.logsIgnorados + ' | Erros Fetch: ' + state.stats.errosFetch +
            ' | Erros Envio: ' + state.stats.errosFlush, 'success');
        beep();
        if (typeof GM_notification === 'function' && !state.silentMode) {
            GM_notification({
                title: 'EPROC - Concluido (' + elapsed + ')',
                text: state.stats.logsNovos + ' novos - ' + state.stats.logsIgnorados + ' ignorados',
                timeout: 8000
            });
        }
        state.processando = false;
        var foiSilencioso = state.silentMode;
        state.silentMode = false;
        if (!foiSilencioso) {
            btn.textContent = '▶ Importar Logs';
            btn.className = 'primary';
        }
        // Atualiza status
        state.ultimaExtracao = new Date().toISOString();
        if (PERFIL_ATUAL) {
            GM_setValue('ultimaExtracao_' + PERFIL_ATUAL, state.ultimaExtracao);
        }
        atualizarBadgeExtracao();

        // Background sync + refresh Relatórios if active
        await buscarDadosAPI(true, true);
        if (state.tabAtiva === 'relatorios') {
            mostrarDashboard();
        }
    }

    // ================================================================
    // ================================================================
    // ABA 2 - RELATORIOS (DASHBOARD BI)
    // ================================================================
    // ================================================================

    var dadosJaCarregados = false;

    async function abrirAbaRelatorios() {
        // Se os dados já foram carregados e estão na memória, apenas mostra o dashboard
        if (dadosJaCarregados && state.dadosBrutos) {
            mostrarDashboard();
            return;
        }

        // Se ainda não carregou mas o early fetch está rodando, aguarda
        if (_earlyDadosPromise) {
            showLoading();
            try {
                var dados = await _earlyDadosPromise;
                _earlyDadosPromise = null;
                if (dados && processarDadosHelper(dados)) {
                    mostrarDashboard();
                    return;
                }
            } catch (e) {
                _earlyDadosPromise = null;
            }
        }

        // Se não carregou e não tem early fetch rodando, busca os dados da API
        await buscarDadosAPI(false);
    }

    async function inicializarRelatorios() {
        await abrirAbaRelatorios();
    }

    function showLoading() {
        document.getElementById('eproc-rel-loading').style.display = 'flex';
        document.getElementById('eproc-rel-empty').style.display = 'none';
        document.getElementById('eproc-dash-grid').style.display = 'none';
    }

    function showEmpty(msg, sub) {
        document.getElementById('eproc-rel-loading').style.display = 'none';
        var empty = document.getElementById('eproc-rel-empty');
        empty.style.display = 'flex';
        empty.querySelector('.e-text').textContent = msg || 'Nenhum dado encontrado';
        empty.querySelector('.e-sub').textContent = sub || 'Execute uma extração primeiro.';
        document.getElementById('eproc-dash-grid').style.display = 'none';
    }

    function mostrarDashboard() {
        document.getElementById('eproc-rel-loading').style.display = 'none';
        document.getElementById('eproc-rel-empty').style.display = 'none';
        document.getElementById('eproc-dash-grid').style.display = 'grid';
        renderDashboard();
    }

    function processarDadosHelper(dados) {
        if (!dados || !dados.logs) return false;
        state.dadosBrutos = dados;
        state.regrasMap = new Map();
        if (dados.regras) {
            dados.regras.forEach(function (r) {
                if (r[0] === undefined || r[0] === null) return;
                var key = String(r[0]).trim();
                if (key) state.regrasMap.set(key, {
                    numRegra: key, grupo: r[1] || '', origem: r[2] || '',
                    controle: r[3] || '', destino: r[4] || '', outros: r[5] || ''
                });
            });
        }
        var badge = document.getElementById('eproc-rel-badge');
        if (badge && dados.logs) badge.textContent = fmtNumero(dados.logs.length);
        dadosJaCarregados = true;
        popularFiltros(dados);

        // Aplica preset de data temporal padrão imediatamente para que os dados detalhados e gráficos fiquem 100% pré-calculados na memória!
        if (!state.presetAtivo) {
            aplicarPresetData('tudo');
        }

        return true;
    }

    async function buscarDadosAPI(forcar, background) {
        // Se já carregado e não é refresh forçado, só reexibe
        if (state.dadosBrutos && dadosJaCarregados && !forcar) {
            if (!background) mostrarDashboard();
            return;
        }

        if (!background) showLoading();
        var subTxt = document.getElementById('eproc-rel-loading-sub');
        if (subTxt) {
            subTxt.textContent = '🔄 Conectando ao banco de dados... (0s)';
        }

        var startTime = Date.now();
        var timerInterval = setInterval(function () {
            if (subTxt) {
                var elapsed = Math.round((Date.now() - startTime) / 1000);
                subTxt.textContent = '⏳ Carregando dados... (' + elapsed + 's)';
            }
        }, 1000);

        try {
            var results = await Promise.all([
                supabaseGet('logs', 'select=*'),
                supabaseGet('regras', 'select=*')
            ]);

            clearInterval(timerInterval);

            if (subTxt) {
                var elapsed = Math.round((Date.now() - startTime) / 1000);
                subTxt.textContent = '📥 Dados recebidos em ' + elapsed + 's! Processando...';
            }

            var dados = {
                logs: logsFromSupabase(results[0]),
                regras: regrasFromSupabase(results[1])
            };

            if (!dados.logs || dados.logs.length === 0) {
                showEmpty('Nenhum dado encontrado', 'O banco pode estar vazio. Execute extrações primeiro.');
                return;
            }

            processarDadosHelper(dados);

            if (!state.presetAtivo) aplicarPresetData('tudo');
            else renderDashboard();

            if (!background) mostrarDashboard();

        } catch (err) {
            clearInterval(timerInterval);
            adicionarLog('Erro ao buscar dados: ' + err.message, 'error');
            if (!background) document.getElementById('eproc-rel-loading').style.display = 'none';
            var empty = document.getElementById('eproc-rel-empty');
            empty.style.display = 'flex';
            empty.querySelector('.e-text').textContent = 'Erro ao carregar: ' + err.message;
        }
    }

    function popularFiltros(dados) {
        // Grupos
        var grupos = new Set();
        if (dados.regras) {
            dados.regras.forEach(function (r) {
                if (r[1]) grupos.add(r[1].trim());
            });
        }
        if (dados.logs) {
            dados.logs.forEach(function (log) {
                var regraKey = String(log[4] || log.regra || '').trim();
                var regraInfo = state.regrasMap.get(regraKey);
                if (regraInfo && regraInfo.grupo) grupos.add(regraInfo.grupo);
            });
        }
        var grupoSelect = document.getElementById('eproc-filtro-grupo');
        var gruposArr = Array.from(grupos).sort(function(a, b) { return a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}); });
        grupoSelect.innerHTML = '<option value="todos">Todos</option>' +
            gruposArr.map(function (g) { return '<option value="' + escHTML(g) + '">' + escHTML(g) + '</option>'; }).join('');

        // Regras filter - from LOGS tab (rules that actually appear in logs)
        var regraSelect = document.getElementById('eproc-filtro-regra');
        var regrasLogs = [];
        if (dados.logs) {
            dados.logs.forEach(function (log) {
                var r = String(log[4] || log.regra || '').trim();
                if (r) regrasLogs.push(r);
            });
        }
        regrasLogs = Array.from(new Set(regrasLogs)).sort(function (a, b) {
            return parseInt(a) - parseInt(b);
        });
        regraSelect.innerHTML = '<option value="todas">Todas</option>' +
            regrasLogs.map(function (r) { return '<option value="' + escHTML(r) + '">Regra ' + escHTML(r) + '</option>'; }).join('');

        // Glossary - from Automatizações tab (all configured rules with details)
        var glossSelect = document.getElementById('eproc-glossario-select');
        var regrasAuto = [];
        if (dados.regras) {
            dados.regras.forEach(function (r) {
                if (r[0] !== undefined && r[0] !== null) regrasAuto.push(String(r[0]).trim());
            });
        }
        regrasAuto = Array.from(new Set(regrasAuto)).sort(function (a, b) {
            return parseInt(a) - parseInt(b);
        });
        glossSelect.innerHTML = '<option value="">Selecione uma regra...</option>' +
            regrasAuto.map(function (r) { return '<option value="' + escHTML(r) + '">Regra ' + escHTML(r) + '</option>'; }).join('');

        renderizarRegrasParalisadas(dados);

        // Update badge
        if (dados.logs) {
            var badge = document.getElementById('eproc-rel-badge');
            if (badge) badge.textContent = fmtNumero(dados.logs.length);
        }
        rebindFiltros();
    }

    function renderizarRegrasParalisadas(dados) {
        var container = document.getElementById('eproc-regras-paralisadas');
        if (!container) return;
        if (!dados.regras || !dados.logs) {
            container.innerHTML = '';
            return;
        }

        var ultimaExecPorRegra = {};
        dados.logs.forEach(function (log) {
            var r = String(log[4] || log.regra || '').trim();
            var dataStr = log[2] || log.data;
            if (!r || !dataStr) return;
            var partesStr = dataStr.split(' ');
            var dtStr = partesStr[0];
            if (dtStr.indexOf('/') !== -1) {
                var p = dtStr.split('/');
                dtStr = p[2] + '-' + p[1] + '-' + p[0];
            }
            var tStr = partesStr[1] || '00:00:00';
            var dt = new Date(dtStr + 'T' + tStr);
            if (isNaN(dt)) return;
            if (!ultimaExecPorRegra[r] || dt > ultimaExecPorRegra[r]) {
                ultimaExecPorRegra[r] = dt;
            }
        });

        var paralisadas = [];
        var hoje = new Date();
        dados.regras.forEach(function (regraData) {
            var r = String(regraData[0]).trim();
            if (!r) return;
            var ultDate = ultimaExecPorRegra[r];
            if (!ultDate) return;
            
            var diffMs = hoje - ultDate;
            var diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            if (diffDias >= 5) {
                paralisadas.push({
                    regra: r,
                    grupo: String(regraData[1]).trim(),
                    dias: diffDias,
                    ultimaExec: ultDate
                });
            }
        });

        if (paralisadas.length === 0) {
            container.innerHTML = '';
            return;
        }

        paralisadas.sort(function(a, b) { return b.dias - a.dias; });

        var html = '<div class="rg-paral">' +
                   '<div class="rg-paral-title">Regras Paralisadas <span class="rg-paral-badge">' + paralisadas.length + '</span></div>' +
                   '<div style="font-size:8px;color:#8b949e;margin:0 0 6px 0">Não executadas há 5 dias ou mais</div>' +
                   '<div class="rg-paral-list">';
        
        paralisadas.forEach(function(p) {
            html += '<div class="rg-paral-item">' +
                    '<div class="rg-paral-left">Regra ' + escHTML(p.regra) + '<span>' + escHTML(p.grupo) + '</span></div>' +
                    '<div class="rg-paral-right">' + p.dias + ' Dias' +
                    '<span class="rg-paral-ultima">Última: ' +
                        (p.ultimaExec ? fmtDataBR(p.ultimaExec) : '—') +
                    '</span></div></div>';
        });

        html += '</div></div>';
        container.innerHTML = html;
    }

    function getGrupoColor(nome) {
        var cores = [
            { dark: '#58a6ff', light: '#0f62fe' },
            { dark: '#3fb950', light: '#16a34a' },
            { dark: '#f79939', light: '#ea580c' },
            { dark: '#f778ba', light: '#db2777' },
            { dark: '#bc8cff', light: '#7c3aed' },
            { dark: '#56d4dd', light: '#0891b2' },
            { dark: '#f85149', light: '#dc2626' },
            { dark: '#d29922', light: '#ca8a04' },
        ];
        var hash = 0;
        for (var i = 0; i < nome.length; i++) hash = ((hash << 5) - hash) + nome.charCodeAt(i);
        return cores[Math.abs(hash) % cores.length];
    }

    function buscarHistoricoProcessoInline() {
        var input = document.getElementById('eproc-hist-input');
        if (!input) return;
        var query = input.value.trim().replace(/[.\-]/g, '').toLowerCase();
        if (!query) return;
        var overlay = document.getElementById('eproc-hist-overlay');
        var resDiv = document.getElementById('eproc-hist-results');
        if (!resDiv || !overlay) return;
        if (!state.dadosBrutos || !state.dadosBrutos.logs) {
            resDiv.innerHTML = '<div class="hr-total">Nenhum dado bruto dispon\u00EDvel.</div>';
            overlay.classList.add('active');
            return;
        }

        var encontrados = [];
        var primeiroProc = '';
        state.dadosBrutos.logs.forEach(function(l) {
            var proc = String(l[1] || l.processo || '');
            var procNorm = proc.replace(/[.\-]/g, '').trim().toLowerCase();
            if (procNorm.indexOf(query) !== -1) {
                encontrados.push({ log: l, proc: proc });
                if (!primeiroProc) primeiroProc = proc.trim();
            }
        });

        if (encontrados.length === 0) {
            resDiv.innerHTML = '<div class="hr-total">Nenhuma execu\u00E7\u00E3o encontrada para: ' + escHTML(input.value.trim()) + '</div>';
            overlay.classList.add('active');
            return;
        }

        encontrados.sort(function(a, b) {
            var dtA = new Date((a.log[2] || a.log.data || '').replace(' ', 'T'));
            var dtB = new Date((b.log[2] || b.log.data || '').replace(' ', 'T'));
            if (isNaN(dtA)) dtA = new Date(0);
            if (isNaN(dtB)) dtB = new Date(0);
            return dtB - dtA;
        });

        var html = '<div class="hr-total">Total de execu\u00E7\u00F5es: ' + encontrados.length + ' &mdash; <span class="hl-proc">' + escHTML(primeiroProc) + '</span></div>';
        html += '<table><thead><tr><th style="width:28%">Data</th><th style="width:24%">Regra</th><th style="width:48%">Grupo</th></tr></thead><tbody>';
        encontrados.forEach(function(e) {
            var l = e.log;
            var regra = String(l[4] || l.regra || '').trim();
            var dataVal = l[2] || l.dataOnly || l.data || '';
            var horaVal = l[3] || l.hora || '';
            var dataFormatada = fmtDataBR(dataVal);
            var horaFormatada = fmtHoraBR(horaVal);
            var dataHora = (dataFormatada && horaFormatada) ? (dataFormatada + ' \u00E0s ' + horaFormatada) : (dataFormatada || horaFormatada || '\u2014');
            var rInfo = state.regrasMap.get(regra) || {};
            var grupo = rInfo.grupo || '-';
            var cor = getGrupoColor(grupo);
            var corDark = state.darkMode ? cor.dark : cor.light;
            html += '<tr>' +
                    '<td class="col-data">' + escHTML(dataHora) + '</td>' +
                    '<td class="col-regra" style="color:' + corDark + '">' + escHTML(regra) + '</td>' +
                    '<td><span class="grupo-badge" style="background:' + corDark + '1a;color:' + corDark + '">' + escHTML(grupo) + '</span></td>' +
                    '</tr>';
        });
        html += '</tbody></table>';

        resDiv.innerHTML = html;
        overlay.classList.add('active');
    }

    function aplicarPresetData(preset) {
        try {
        var autoRender = state.dadosFiltrados ? true : false;
        var hoje = new Date();
        var inicio = new Date();
        var fim = new Date();

        switch (preset) {
            case 'hoje':
                inicio = new Date();
                inicio.setHours(0, 0, 0, 0);
                fim = new Date();
                fim.setHours(23, 59, 59, 999);
                break;
            case '7d':
                inicio.setDate(hoje.getDate() - 6);
                break;
            case '15d':
                inicio.setDate(hoje.getDate() - 14);
                break;
            case '30d':
                inicio.setDate(hoje.getDate() - 29);
                break;
            case 'mes':
                inicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
                break;
            case 'ano':
                inicio.setFullYear(hoje.getFullYear() - 1);
                inicio.setDate(inicio.getDate() + 1);
                break;
            case 'tudo':
                inicio = null;
                fim = null;
                break;
        }
        document.getElementById('eproc-filtro-data-inicio').value = inicio ? fmtDataISO(inicio) : '';
        document.getElementById('eproc-filtro-data-fim').value = fim ? fmtDataISO(fim) : '';
        state.filters.dataInicio = inicio;
        state.filters.dataFim = fim;
        state.presetAtivo = preset;
        atualizarDropdownsPorFiltros();
        if (autoRender) renderDashboard();
        } catch (e) { adicionarLog('Erro aplicarPresetData: ' + e.message, 'error'); }
    }

    // ================================================================
    // FILTER ENGINE
    // ================================================================
    function atualizarDropdownsPorFiltros() {
        if (!state.dadosBrutos || !state.dadosBrutos.logs) return;
        var f = state.filters;
        var dataInicioStr = f.dataInicio ? fmtDataISO(f.dataInicio) : null;
        var dataFimStr = f.dataFim ? fmtDataISO(f.dataFim) : null;
        var grupoSel = f.grupo;

        var grupos = new Set();
        var regras = new Set();

        state.dadosBrutos.logs.forEach(function (log) {
            // 1. Filtragem temporal estrita
            var dataLog = log[2] || log.dataOnly || log.data || '';
            var dStr = fmtDataISO(dataLog);
            if (!dStr) return;

            if (dataInicioStr && dStr < dataInicioStr) return;
            if (dataFimStr && dStr > dataFimStr) return;

            var regraKey = String(log[4] || log.regra || '').trim();
            var regraInfo = state.regrasMap.get(regraKey);

            // 2. Adiciona aos grupos disponíveis NESTA data
            if (regraInfo && regraInfo.grupo) {
                grupos.add(regraInfo.grupo);
            } else if (regraKey) {
                grupos.add('Não Classificado');
            }

            // 3. Regras dependem da data E (opcionalmente) do grupo selecionado
            if (grupoSel === 'todos' || (regraInfo && (regraInfo.grupo === grupoSel || (!regraInfo.grupo && grupoSel === 'Não Classificado')))) {
                if (regraKey) regras.add(regraKey);
            }
        });

        // Atualiza Grupos
        var grupoSelect = document.getElementById('eproc-filtro-grupo');
        var valGrupoAnterior = grupoSelect.value;
        var gruposArr = Array.from(grupos).sort(function(a, b) { return a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}); });

        var grupoHtml = '<option value="todos">Todos (' + gruposArr.length + ')</option>';
        gruposArr.forEach(function (g) {
            grupoHtml += '<option value="' + escHTML(g) + '">' + escHTML(g) + '</option>';
        });
        grupoSelect.innerHTML = grupoHtml;

        if (valGrupoAnterior === 'todos' || grupos.has(valGrupoAnterior)) {
            grupoSelect.value = valGrupoAnterior;
        } else {
            grupoSelect.value = 'todos';
            state.filters.grupo = 'todos';
        }

        // Atualiza Regras
        var regraSelect = document.getElementById('eproc-filtro-regra');
        var valRegraAnterior = regraSelect.value;
        var regrasArr = Array.from(regras).sort(function (a, b) { return parseInt(a) - parseInt(b); });

        var regraHtml = '<option value="todas">Todas (' + regrasArr.length + ')</option>';
        regrasArr.forEach(function (r) {
            regraHtml += '<option value="' + escHTML(r) + '">Regra ' + escHTML(r) + '</option>';
        });
        regraSelect.innerHTML = regraHtml;

        if (valRegraAnterior === 'todas' || regras.has(valRegraAnterior)) {
            regraSelect.value = valRegraAnterior;
        } else {
            regraSelect.value = 'todas';
            state.filters.regra = 'todas';
        }
    }

    function rebindFiltros() {
        var el = document.getElementById('eproc-filtro-grupo');
        if (el) el.onchange = function () {
            state.filters.grupo = this.value;
            atualizarDropdownsPorFiltros();
            if (state.dadosFiltrados) renderDashboard();
        };
        el = document.getElementById('eproc-filtro-regra');
        if (el) el.onchange = function () {
            state.filters.regra = this.value;
            if (state.dadosFiltrados) renderDashboard();
        };
    }

    function aplicarFiltrosEAplicar() {
        if (!state.dadosBrutos) return;
        try {
        var dataInicioVal = document.getElementById('eproc-filtro-data-inicio').value;
        var dataFimVal = document.getElementById('eproc-filtro-data-fim').value;
        state.filters.dataInicio = dataInicioVal ? new Date(dataInicioVal + 'T00:00:00') : null;
        state.filters.dataFim = dataFimVal ? new Date(dataFimVal + 'T23:59:59') : null;
        state.filters.grupo = document.getElementById('eproc-filtro-grupo').value;
        state.filters.regra = document.getElementById('eproc-filtro-regra').value;
        state.filters.processo = document.getElementById('eproc-filtro-processo').value.replace(/[.\-]/g, '').trim().toLowerCase();

        atualizarDropdownsPorFiltros();
        renderDashboard();
        } catch (e) { adicionarLog('Erro aplicarFiltros: ' + e.message, 'error'); }
    }

    function limparFiltros() {
        try {
        document.getElementById('eproc-filtro-data-inicio').value = '';
        document.getElementById('eproc-filtro-data-fim').value = '';
        document.getElementById('eproc-filtro-grupo').value = 'todos';
        document.getElementById('eproc-filtro-regra').value = 'todas';
        document.getElementById('eproc-filtro-processo').value = '';
        state.filters = {
            dataInicio: null,
            dataFim: null,
            grupo: 'todos',
            regra: 'todas',
            processo: '',
            ordenacao: state.filters.ordenacao || 'frequencia-desc',
            pieDimensao: state.filters.pieDimensao || 'grupo'
        };
        document.querySelectorAll('#eproc-date-presets span').forEach(function (s) {
            s.classList.remove('active');
            if (s.dataset.preset === 'tudo') s.classList.add('active');
        });
        state.presetAtivo = 'tudo';
        atualizarDropdownsPorFiltros();
        renderDashboard();
        } catch (e) { adicionarLog('Erro limparFiltros: ' + e.message, 'error'); }
    }

    function filtrarDados() {
        if (!state.dadosBrutos || !state.dadosBrutos.logs) return [];
        var logs = state.dadosBrutos.logs;
        var f = state.filters;

        return logs.filter(function (log) {
            var dataLog = log[2] || log.dataOnly || log.data || '';
            var dataStr = fmtDataBR(dataLog).split(' ')[0];
            var partes = dataStr.split('/');
            if (partes.length === 3) {
                var dStr = partes[2] + '-' + partes[1] + '-' + partes[0];
                var dataInicioStr = f.dataInicio ? fmtDataISO(f.dataInicio) : null;
                var dataFimStr = f.dataFim ? fmtDataISO(f.dataFim) : null;

                if (dataInicioStr && dStr < dataInicioStr) return false;
                if (dataFimStr && dStr > dataFimStr) return false;
            } else if (f.dataInicio || f.dataFim) {
                return false;
            }

            var regraKey = String(log[4] || log.regra || '').trim();
            if (f.regra !== 'todas' && regraKey !== f.regra) return false;

            if (f.grupo !== 'todos') {
                var regraInfo = state.regrasMap.get(regraKey);
                if (!regraInfo || regraInfo.grupo !== f.grupo) return false;
            }

            if (f.processo) {
                var query = f.processo.trim().toLowerCase();
                if (query) {
                    var proc = String(log[1] || log.processo || '').replace(/[.\-]/g, '').toLowerCase();
                    var matchProc = proc.indexOf(query) !== -1;
                    if (!matchProc) return false;
                }
            }

            return true;
        });
    }

    // ================================================================
    // RENDER DASHBOARD
    // ================================================================
    var tabelaPagina = 0;
    var tabelaPagSize = 15;

    function atualizarBotaoMetrica() {
        var btn = document.getElementById('eproc-metrica-toggle');
        if (!btn) return;
        if (state.metricaAtiva === 'processos') {
            btn.textContent = 'Processos impactados';
        } else {
            btn.textContent = 'Execuções';
        }
    }

    function renderDashboard() {
        try {
        atualizarBotaoMetrica();
        var dadosFiltrados = filtrarDados();
        if (!dadosFiltrados || dadosFiltrados.length === 0) {
            document.getElementById('eproc-dash-summary').textContent = '📌 Nenhum resultado para os filtros selecionados.';
            document.getElementById('kpi-exec').textContent = '0';
            document.getElementById('kpi-media-exec').textContent = '0';
            document.getElementById('kpi-proc').textContent = '0';
            document.getElementById('kpi-media-proc').textContent = '0';
            document.querySelectorAll('.kpi-delta').forEach(function (el) { el.textContent = ''; });
            destruirCharts();
            renderTabela([]);
            return;
        }

        state.dadosFiltrados = dadosFiltrados;
        tabelaPagina = 0;

        // Summary
        var grupos = new Set();
        var regrasSet = new Set();
        dadosFiltrados.forEach(function (log) {
            var rk = String(log[4] || log.regra || '').trim();
            regrasSet.add(rk);
            var ri = state.regrasMap.get(rk);
            if (ri && ri.grupo) grupos.add(ri.grupo);
        });
        var dataInicio = state.filters.dataInicio;
        var dataFim = state.filters.dataFim;
        var sumInicio = dataInicio ? fmtDataBR(dataInicio) : '—';
        var sumFim = dataFim ? fmtDataBR(dataFim) : '—';
        document.getElementById('eproc-dash-summary').textContent =
            '📌 ' + fmtNumero(dadosFiltrados.length) + ' execuções · ' +
            fmtNumero(regrasSet.size) + ' regras · ' +
            fmtNumero(grupos.size) + ' grupos · ' +
            fmtNumero(new Set(dadosFiltrados.map(function (l) { return l[1] || l.processo; })).size) + ' processos' +
            (sumInicio !== '—' ? ' · ' + sumInicio + ' a ' + sumFim : '');

        // KPIs
        var totalExec = dadosFiltrados.length;
        var totalProc = new Set(dadosFiltrados.map(function (l) { return l[1] || l.processo; })).size;
        var dias = new Set();
        dadosFiltrados.forEach(function (l) {
            var d = fmtDataBR(l[2] || l.dataOnly || l.data || '').split(' ')[0];
            if (d) dias.add(d);
        });
        var numDias = dias.size || 1;
        var mediaExecDia = Math.round(totalExec / numDias);
        var mediaProcDia = Math.round(totalProc / numDias);
        document.getElementById('kpi-exec').textContent = fmtNumero(totalExec);
        document.getElementById('kpi-media-exec').textContent = fmtNumero(mediaExecDia);
        document.getElementById('kpi-proc').textContent = fmtNumero(totalProc);
        document.getElementById('kpi-media-proc').textContent = fmtNumero(mediaProcDia);

        // Delta comparison (vs previous period)
        document.getElementById('kpi-exec-delta').textContent = '';
        document.getElementById('kpi-proc-delta').textContent = '';

        if (state.dadosBrutos && state.dadosBrutos.logs && dadosFiltrados.length > 0) {
            var dInicio = dataInicio;
            var dFim = dataFim;

            if (!dInicio || !dFim) {
                // Se no preset Tudo (datas nulas), busca as datas limites reais nos logs filtrados
                var datasValidas = [];
                dadosFiltrados.forEach(function (l) {
                    var dStr = fmtDataBR(l[2] || l.dataOnly || l.data || '').split(' ')[0];
                    if (dStr && dStr.indexOf('/') !== -1) datasValidas.push(dStr);
                });
                if (datasValidas.length > 0) {
                    datasValidas.sort(function (a, b) {
                        var pa = a.split('/'), pb = b.split('/');
                        return pa[2] - pb[2] || pa[1] - pb[1] || pa[0] - pb[0];
                    });
                    var pMin = datasValidas[0].split('/');
                    var pMax = datasValidas[datasValidas.length - 1].split('/');
                    dInicio = new Date(parseInt(pMin[2], 10), parseInt(pMin[1], 10) - 1, parseInt(pMin[0], 10), 12, 0, 0);
                    dFim = new Date(parseInt(pMax[2], 10), parseInt(pMax[1], 10) - 1, parseInt(pMax[0], 10), 12, 0, 0);
                }
            }

            var deltaBaseInicio = dInicio;
            var deltaBaseFim = dFim;

            var periodoAtual = 7 * 86400000;
            if (deltaBaseInicio && deltaBaseFim) {
                var iStr = fmtDataISO(deltaBaseInicio);
                var fStr = fmtDataISO(deltaBaseFim);
                if (iStr && fStr) {
                    var tI = new Date(iStr + 'T12:00:00').getTime();
                    var tF = new Date(fStr + 'T12:00:00').getTime();
                    var diffDias = Math.max(Math.round((tF - tI) / 86400000) + 1, 1);
                    periodoAtual = diffDias * 86400000;
                }
            }

            var periodoAntInicio = deltaBaseInicio ? new Date(deltaBaseInicio.getTime() - periodoAtual) : null;
            var periodoAntFim = deltaBaseInicio || new Date(Date.now() - 14 * 86400000);

            if (periodoAntInicio) {
                var antInicioStr = fmtDataISO(periodoAntInicio);
                var baseInicioStr = deltaBaseInicio ? fmtDataISO(deltaBaseInicio) : null;
                var f = state.filters;
                var logsAnteriores = state.dadosBrutos.logs.filter(function (l) {
                    var d = fmtDataBR(l[2] || l.dataOnly || l.data || '').split(' ')[0];
                    var partes = d.split('/');
                    if (partes.length !== 3) return false;
                    var dStr = partes[2] + '-' + partes[1] + '-' + partes[0];
                    if (dStr < antInicioStr || (baseInicioStr && dStr >= baseInicioStr)) return false;
                    var regraKey = String(l[4] || l.regra || '').trim();
                    if (f.regra !== 'todas' && regraKey !== f.regra) return false;
                    if (f.grupo !== 'todos') {
                        var regraInfo = state.regrasMap.get(regraKey);
                        if (!regraInfo || regraInfo.grupo !== f.grupo) return false;
                    }
                    if (f.processo) {
                        var query = f.processo.trim().toLowerCase();
                        if (query) {
                            var proc = String(l[1] || l.processo || '').toLowerCase();
                            if (proc.indexOf(query) === -1) return false;
                        }
                    }
                    return true;
                });
                var qtdAnterior = logsAnteriores.length;

                if (qtdAnterior > 0) {
                    var delta = Math.round((totalExec - qtdAnterior) / qtdAnterior * 100);
                    if (delta > 0) {
                        document.getElementById('kpi-exec-delta').innerHTML = '<strong style="color:#3fb950">▲ ' + delta + '%</strong> comparado ao período anterior';
                    } else if (delta < 0) {
                        document.getElementById('kpi-exec-delta').innerHTML = '<strong style="color:#f85149">▼ ' + Math.abs(delta) + '%</strong> comparado ao período anterior';
                    } else {
                        document.getElementById('kpi-exec-delta').innerHTML = '0% comparado ao período anterior';
                    }
                } else if (totalExec > 0) {
                    document.getElementById('kpi-exec-delta').innerHTML = '';
                }

                var procAnterior = new Set(logsAnteriores.map(function (l) { return l[1] || l.processo; })).size;

                if (procAnterior > 0) {
                    var deltaProc = Math.round((totalProc - procAnterior) / procAnterior * 100);
                    if (deltaProc > 0) {
                        document.getElementById('kpi-proc-delta').innerHTML = '<strong style="color:#3fb950">▲ ' + deltaProc + '%</strong> comparado ao período anterior';
                    } else if (deltaProc < 0) {
                        document.getElementById('kpi-proc-delta').innerHTML = '<strong style="color:#f85149">▼ ' + Math.abs(deltaProc) + '%</strong> comparado ao período anterior';
                    } else {
                        document.getElementById('kpi-proc-delta').innerHTML = '0% comparado ao período anterior';
                    }
                } else if (totalProc > 0) {
                    document.getElementById('kpi-proc-delta').innerHTML = '';
                }
            }
        }

        // Charts
        carregarChartJS().then(function () {
            renderChartTemporal(dadosFiltrados);
            renderChartDistrib(dadosFiltrados);
            renderChartTop(dadosFiltrados);
        });

        // Table
        renderTabela(dadosFiltrados);
        } catch (e) { adicionarLog('Erro renderDashboard: ' + e.message, 'error'); }
    }

    // ================================================================
    // CHART MANAGEMENT
    // ================================================================
    function destruirCharts() {
        Object.keys(state.chartInstances).forEach(function (key) {
            if (state.chartInstances[key]) {
                state.chartInstances[key].destroy();
                delete state.chartInstances[key];
            }
        });
    }

    function baixarChartPNG(chartId) {
        var chart = state.chartInstances[chartId];
        if (!chart) return;

        // Desativa hovers ativos imediatamente antes de capturar a imagem
        if (typeof chart.setActiveElements === 'function') {
            chart.setActiveElements([]);
        }
        if (chart.tooltip && typeof chart.tooltip.setActiveElements === 'function') {
            try {
                chart.tooltip.setActiveElements([], { x: 0, y: 0 });
            } catch (e) { }
        }

        // Backup original options (sem operador opcional ES6 para compatibilidade máxima ES5)
        var originalTitleDisplay = (chart.options.plugins && chart.options.plugins.title && chart.options.plugins.title.display) || false;
        var originalTitleText = (chart.options.plugins && chart.options.plugins.title && chart.options.plugins.title.text) || '';
        var originalTooltipEnabled = (chart.options.plugins && chart.options.plugins.tooltip && chart.options.plugins.tooltip.enabled !== undefined) ? chart.options.plugins.tooltip.enabled : true;
        var originalLegendDisplay = (chart.options.plugins && chart.options.plugins.legend && chart.options.plugins.legend.display !== undefined) ? chart.options.plugins.legend.display : true;
        var originalAnimation = chart.options.animation;

        // Backup interaction/hover modes
        var originalInteractionMode = chart.options.interaction ? chart.options.interaction.mode : undefined;
        var originalHoverMode = chart.options.hover ? chart.options.hover.mode : undefined;

        // Backup e ajuste das escalas de limites max para evitar cortes de labels nas bordas do canvas
        var originalXMax = (chart.options.scales && chart.options.scales.x && chart.options.scales.x.max !== undefined) ? chart.options.scales.x.max : undefined;
        var originalYMax = (chart.options.scales && chart.options.scales.y && chart.options.scales.y.max !== undefined) ? chart.options.scales.y.max : undefined;

        // Calcula maior valor do dataset e adiciona margem de 18% para que as labels caibam no canvas
        if (chartId === 'top' && chart.options.scales && chart.options.scales.x) {
            var maxVal = 0;
            chart.data.datasets.forEach(function (dataset) {
                dataset.data.forEach(function (val) {
                    if (val > maxVal) maxVal = val;
                });
            });
            chart.options.scales.x.max = Math.ceil(maxVal * 1.18) || undefined;
        } else if (chartId === 'temporal' && chart.options.scales && chart.options.scales.y) {
            var maxVal = 0;
            chart.data.datasets.forEach(function (dataset) {
                dataset.data.forEach(function (val) {
                    if (val > maxVal) maxVal = val;
                });
            });
            chart.options.scales.y.max = Math.ceil(maxVal * 1.18) || undefined;
        }

        var sumInicio = state.filters.dataInicio ? fmtDataBR(state.filters.dataInicio) : '';
        var sumFim = state.filters.dataFim ? fmtDataBR(state.filters.dataFim) : '';

        // Se alguma das datas de filtro for nula (Preset "Tudo"), extraímos as datas limites reais presentes nos próprios dados!
        if (!sumInicio || !sumFim) {
            var dados = state.dadosFiltrados || [];
            if (dados.length > 0) {
                var datasValidas = [];
                dados.forEach(function (l) {
                    var dVal = l[2] || l.dataOnly || l.data || '';
                    var dFmt = fmtDataBR(dVal).split(' ')[0];
                    if (dFmt && dFmt.indexOf('/') !== -1) {
                        datasValidas.push(dFmt);
                    }
                });
                if (datasValidas.length > 0) {
                    datasValidas.sort(function (a, b) {
                        var pa = a.split('/'), pb = b.split('/');
                        return pa[2] - pb[2] || pa[1] - pb[1] || pa[0] - pb[0];
                    });
                    if (!sumInicio) sumInicio = datasValidas[0];
                    if (!sumFim) sumFim = datasValidas[datasValidas.length - 1];
                }
            }
        }
        if (!sumInicio) sumInicio = 'Início';
        if (!sumFim) sumFim = 'Fim';

        var titleText = '';
        var isProc = state.metricaAtiva === 'processos';
        if (chartId === 'temporal') {
            titleText = (isProc ? 'Série temporal de processos impactados no período ' : 'Série temporal de execuções no período ') + sumInicio + ' a ' + sumFim;
        } else if (chartId === 'distrib') {
            var metricaStr = isProc ? 'processos impactados' : 'execuções';
            var dimStr = (state.filters.pieDimensao || 'grupo').toUpperCase();
            titleText = 'Gráfico de distribuição: ' + metricaStr + ' no período ' + sumInicio + ' a ' + sumFim + ' por ' + dimStr;
        } else if (chartId === 'top') {
            titleText = (isProc ? 'Regras com mais processos impactados no período ' : 'Regras mais executadas no período ') + sumInicio + ' a ' + sumFim;
        } else {
            titleText = (isProc ? 'Processos impactados no período ' : 'Execuções no período ') + sumInicio + ' a ' + sumFim;
        }

        // Apply export settings (colapsando legendas e tips)
        if (!chart.options.plugins) chart.options.plugins = {};
        if (!chart.options.plugins.title) chart.options.plugins.title = {};
        chart.options.plugins.title.display = true;
        chart.options.plugins.title.text = titleText;
        chart.options.plugins.title.color = state.darkMode ? '#8b949e' : '#1f2328';
        chart.options.plugins.title.font = { size: 14, weight: 'bold' };
        chart.options.plugins.title.padding = { bottom: 20 };

        if (!chart.options.plugins.tooltip) chart.options.plugins.tooltip = {};
        chart.options.plugins.tooltip.enabled = false; // Colapsa tips

        if (!chart.options.plugins.legend) chart.options.plugins.legend = {};
        // Exibe a legenda na imagem de exportação apenas para o gráfico de Distribuição (pizza/rosca) para identificar as cores!
        chart.options.plugins.legend.display = (chartId === 'distrib');

        if (!chart.options.interaction) chart.options.interaction = {};
        chart.options.interaction.mode = 'none'; // Desativa interações de hover

        if (!chart.options.hover) chart.options.hover = {};
        chart.options.hover.mode = 'none'; // Desativa hovers visuais

        chart.options.animation = false; // Sem animação para render imediato
        chart.options.isExporting = true; // Sinaliza exportação no options
        chart.isExporting = true; // Sinaliza exportação na instância

        // Ajustar tamanho do canvas se houver muitos dados (evitar sobreposição na exportação)
        var canvas = chart.canvas;
        var originalWidth = canvas.parentElement.style.width;
        var originalHeight = canvas.parentElement.style.height;
        if (chartId === 'distrib') {
            var legendItems = chart.data.labels ? chart.data.labels.length : 0;
            var requiredHeight = Math.max(700, legendItems * 35);
            canvas.parentElement.style.height = requiredHeight + 'px';
            canvas.parentElement.style.width = '1000px';
            chart.resize();
        }

        chart.update();

        // Small delay to ensure onComplete drawing is finished
        setTimeout(function () {
            var link = document.createElement('a');
            link.download = 'ProjetoLOG-' + chartId + '-' + new Date().toISOString().slice(0, 10) + '.png';
            link.href = chart.toBase64Image();
            link.click();

            // Restore size
            if (chartId === 'distrib') {
                canvas.parentElement.style.width = originalWidth || '';
                canvas.parentElement.style.height = originalHeight || '';
                chart.resize();
            }

            // Restore original options
            if (!chart.options.plugins) chart.options.plugins = {};
            if (!chart.options.plugins.title) chart.options.plugins.title = {};
            chart.options.plugins.title.display = originalTitleDisplay;
            chart.options.plugins.title.text = originalTitleText;

            if (!chart.options.plugins.tooltip) chart.options.plugins.tooltip = {};
            chart.options.plugins.tooltip.enabled = originalTooltipEnabled;

            if (!chart.options.plugins.legend) chart.options.plugins.legend = {};
            chart.options.plugins.legend.display = originalLegendDisplay;

            if (originalInteractionMode !== undefined) {
                chart.options.interaction.mode = originalInteractionMode;
            } else {
                delete chart.options.interaction.mode;
            }

            if (originalHoverMode !== undefined) {
                chart.options.hover.mode = originalHoverMode;
            } else {
                delete chart.options.hover.mode;
            }

            // Restore scales max
            if (chart.options.scales && chart.options.scales.x && chartId === 'top') {
                if (originalXMax !== undefined) chart.options.scales.x.max = originalXMax;
                else delete chart.options.scales.x.max;
            }
            if (chart.options.scales && chart.options.scales.y && chartId === 'temporal') {
                if (originalYMax !== undefined) chart.options.scales.y.max = originalYMax;
                else delete chart.options.scales.y.max;
            }

            chart.options.animation = originalAnimation;
            chart.options.isExporting = false;
            chart.isExporting = false;
            chart.update();
        }, 300);
    }

    function renderChartTemporal(dados) {
        try {
        var canvas = document.getElementById('chart-temporal');
        if (state.chartInstances.temporal) state.chartInstances.temporal.destroy();
        if (!canvas || dados.length === 0) return;

        var isProc = state.metricaAtiva === 'processos';
        var agrupado = {};
        dados.forEach(function (l) {
            var d = fmtDataBR(l[2] || l.dataOnly || l.data || '').split(' ')[0];
            if (!d) return;
            var proc = l[1] || l.processo || '';
            if (!agrupado[d]) {
                agrupado[d] = isProc ? new Set() : 0;
            }
            if (isProc) {
                agrupado[d].add(proc);
            } else {
                agrupado[d]++;
            }
        });
        var datas = Object.keys(agrupado).sort(function (a, b) {
            var pa = a.split('/'), pb = b.split('/');
            return pa[2] - pb[2] || pa[1] - pb[1] || pa[0] - pb[0];
        });
        var valores = datas.map(function (d) {
            return isProc ? agrupado[d].size : agrupado[d];
        });

        var mainColor = isProc ? '#3fb950' : '#58a6ff';
        var bgColor = isProc ? 'rgba(63,185,80,0.08)' : 'rgba(88,166,255,0.08)';

        var ctx = canvas.getContext('2d');
        state.chartInstances.temporal = new Chart(ctx, {
            type: 'line',
            data: {
                labels: datas,
                datasets: [{
                    label: isProc ? 'Processos Impactados' : 'Execuções',
                    data: valores,
                    borderColor: mainColor,
                    backgroundColor: bgColor,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: mainColor,
                    pointBorderColor: state.darkMode ? '#0d1117' : '#ffffff',
                    pointBorderWidth: 1,
                    tension: 0.3,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            afterBody: function (context) {
                                if (!state.filters.processo) return '';
                                var dataIdx = context[0].dataIndex;
                                var dateStr = datas[dataIdx];
                                var procsOnDate = dados.filter(function (l) {
                                    return fmtDataBR(l[2] || l.dataOnly || l.data || '').split(' ')[0] === dateStr;
                                });
                                var tooltips = procsOnDate.map(function (l) {
                                    return 'Regra ' + (l[4] || l.regra || '?');
                                });
                                return Array.from(new Set(tooltips)).join('\n');
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: state.darkMode ? '#ffffff' : '#64748b', font: { size: 9 }, maxTicksLimit: 10 },
                        grid: { color: state.darkMode ? '#21262d' : '#f1f5f9' }
                    },
                    y: {
                        ticks: { color: state.darkMode ? '#ffffff' : '#64748b', font: { size: 9 } },
                        grid: { color: state.darkMode ? '#21262d' : '#f1f5f9' },
                        beginAtZero: true
                    }
                }
            },
            plugins: [{
                id: 'exportLabels',
                beforeDraw: function (chart) {
                    if (!chart.options.isExporting && !chart.isExporting) return;
                    var ctx = chart.ctx;
                    ctx.save();
                    ctx.fillStyle = state.darkMode ? '#0d1117' : '#ffffff';
                    ctx.fillRect(0, 0, chart.width, chart.height);
                    ctx.restore();
                },
                afterDatasetsDraw: function (chart) {
                    if (!chart.options.isExporting && !chart.isExporting) return;
                    var ctx = chart.ctx;
                    ctx.save();
                    ctx.font = 'bold 11px Inter';
                    ctx.fillStyle = state.darkMode ? '#e6edf3' : '#1f2328';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    chart.data.datasets.forEach(function (dataset, i) {
                        var meta = chart.getDatasetMeta(i);
                        meta.data.forEach(function (point, index) {
                            var data = dataset.data[index];
                            if (data > 0) ctx.fillText(data, point.x, point.y - 6);
                        });
                    });
                    ctx.restore();
                }
            }]
        });
        } catch (e) { adicionarLog('Erro renderChartTemporal: ' + e.message, 'error'); }
    }

    function renderChartDistrib(dados) {
        try {
        var canvas = document.getElementById('chart-distrib');
        if (state.chartInstances.distrib) state.chartInstances.distrib.destroy();
        if (!canvas || dados.length === 0) return;

        var isProc = state.metricaAtiva === 'processos';
        var dim = state.filters.pieDimensao || 'grupo';
        var agrupado = {};
        dados.forEach(function (l) {
            var key;
            if (dim === 'grupo') {
                var rk = String(l[4] || l.regra || '').trim();
                var ri = state.regrasMap.get(rk);
                key = ri && ri.grupo ? ri.grupo : 'Sem Grupo';
            } else if (dim === 'regra') {
                key = 'Regra ' + (l[4] || l.regra || '?');
            } else {
                var dFmt = fmtDataBR(l[2] || l.dataOnly || l.data || '').split(' ')[0];
                if (!dFmt) return;
                key = dFmt;
            }
            var proc = l[1] || l.processo || '';
            if (!agrupado[key]) {
                agrupado[key] = isProc ? new Set() : 0;
            }
            if (isProc) {
                agrupado[key].add(proc);
            } else {
                agrupado[key]++;
            }
        });

        var mappedAgrupado = {};
        Object.keys(agrupado).forEach(function (k) {
            mappedAgrupado[k] = isProc ? agrupado[k].size : agrupado[k];
        });

        var entries = Object.entries(mappedAgrupado).sort(function (a, b) { return b[1] - a[1]; });
        var total = entries.reduce(function (acc, e) { return acc + e[1]; }, 0);
        var labels = entries.map(function (e) {
            var pct = total > 0 ? Math.round((e[1] / total) * 100) : 0;
            return e[0] + ' (' + e[1] + ' - ' + pct + '%)';
        });
        var values = entries.map(function (e) { return e[1]; });

        var colors = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#db6d28', '#1f6feb', '#8b949e', '#f0883e', '#56d364'];
        if (isProc) {
            colors = ['#2ea043', '#3fb950', '#56d364', '#7ee787', '#238636', '#1b6329', '#0e4415', '#b4f8c8', '#a3e4d7', '#48c9b0'];
        }

        var ctx = canvas.getContext('2d');
        state.chartInstances.distrib = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: values,
                    backgroundColor: labels.map(function (_, i) { return colors[i % colors.length]; }),
                    borderColor: state.darkMode ? '#0d1117' : '#ffffff',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { color: state.darkMode ? '#ffffff' : '#0f172a', font: { size: 10 }, padding: 8, boxWidth: 10 }
                    }
                }
            },
            plugins: [{
                id: 'exportLabelsPie',
                beforeDraw: function (chart) {
                    if (!chart.options.isExporting && !chart.isExporting) return;
                    var ctx = chart.ctx;
                    ctx.save();
                    ctx.fillStyle = state.darkMode ? '#0d1117' : '#ffffff';
                    ctx.fillRect(0, 0, chart.width, chart.height);
                    ctx.restore();
                },
                afterDatasetsDraw: function (chart) {
                    if (!chart.options.isExporting && !chart.isExporting) return;
                    var ctx = chart.ctx;
                    ctx.save();
                    ctx.font = 'bold 10px Inter';
                    ctx.fillStyle = '#ffffff';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    chart.data.datasets.forEach(function (dataset, i) {
                        var meta = chart.getDatasetMeta(i);
                        meta.data.forEach(function (element, index) {
                            var data = dataset.data[index];
                            if (data > 0) {
                                var position = element.tooltipPosition();
                                ctx.fillText(data, position.x, position.y);
                            }
                        });
                    });
                    ctx.restore();
                }
            }]
        });
        } catch (e) { adicionarLog('Erro renderChartDistrib: ' + e.message, 'error'); }
    }

    function renderChartTop(dados) {
        try {
        var canvas = document.getElementById('chart-top');
        if (state.chartInstances.top) state.chartInstances.top.destroy();
        if (!canvas || dados.length === 0) return;

        var isProc = state.metricaAtiva === 'processos';
        var agrupado = {};
        var maxDatePorRegra = {};
        dados.forEach(function (l) {
            var key = 'Regra ' + (l[4] || l.regra || '?');
            var proc = l[1] || l.processo || '';
            if (!agrupado[key]) {
                agrupado[key] = isProc ? new Set() : 0;
            }
            if (isProc) {
                agrupado[key].add(proc);
            } else {
                agrupado[key]++;
            }
            var dataLog = String(l[2] || l.dataOnly || l.data || '');
            if (dataLog && dataLog > (maxDatePorRegra[key] || '')) maxDatePorRegra[key] = dataLog;
        });

        var mappedAgrupado = {};
        Object.keys(agrupado).forEach(function (k) {
            mappedAgrupado[k] = isProc ? agrupado[k].size : agrupado[k];
        });

        var entries = Object.entries(mappedAgrupado);
        if (state.filters.ordenacao === 'frequencia-desc') {
            entries.sort(function (a, b) { return b[1] - a[1]; });
        } else if (state.filters.ordenacao === 'frequencia-asc') {
            entries.sort(function (a, b) { return a[1] - b[1]; });
        } else {
            entries.sort(function (a, b) {
                var na = parseInt(a[0].replace(/\D/g, '')) || 0;
                var nb = parseInt(b[0].replace(/\D/g, '')) || 0;
                return na - nb;
            });
        }

        var labels = entries.map(function (e) { return e[0]; });
        var values = entries.map(function (e) { return e[1]; });

        var innerDiv = document.getElementById('chart-top-inner');
        if (innerDiv) {
            var requiredHeight = Math.max(150, labels.length * 25);
            innerDiv.style.height = requiredHeight + 'px';
        }

        var colors = labels.map(function (_, i) {
            var c = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#db6d28', '#1f6feb', '#f0883e', '#56d364', '#8b949e'];
            if (isProc) {
                c = ['#2ea043', '#3fb950', '#56d364', '#7ee787', '#238636', '#1b6329', '#0e4415', '#b4f8c8', '#a3e4d7', '#48c9b0'];
            }
            return c[i % c.length];
        });

        var ctx = canvas.getContext('2d');
        state.chartInstances.top = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: isProc ? 'Processos' : 'Execuções',
                    data: values,
                    backgroundColor: colors,
                    borderColor: 'transparent',
                    borderRadius: 3
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            afterBody: function (context) {
                                if (!state.filters.processo) return '';
                                var ruleLabel = labels[context[0].dataIndex];
                                var procsOnRule = dados.filter(function (l) {
                                    return 'Regra ' + (l[4] || l.regra || '?') === ruleLabel;
                                });
                                var tooltips = procsOnRule.map(function (l) {
                                    return fmtDataBR(l[2] || l.dataOnly || l.data || '').split(' ')[0];
                                });
                                return Array.from(new Set(tooltips)).join('\n');
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: state.darkMode ? '#ffffff' : '#64748b', font: { size: 9 } },
                        grid: { color: state.darkMode ? '#21262d' : '#f1f5f9' },
                        beginAtZero: true
                    },
                    y: {
                        ticks: { color: state.darkMode ? '#ffffff' : '#64748b', font: { size: 8 } },
                        grid: { display: false }
                    }
                }
            },
            plugins: [{
                id: 'exportLabelsBar',
                beforeDraw: function (chart) {
                    if (!chart.options.isExporting && !chart.isExporting) return;
                    var ctx = chart.ctx;
                    ctx.save();
                    ctx.fillStyle = state.darkMode ? '#0d1117' : '#ffffff';
                    ctx.fillRect(0, 0, chart.width, chart.height);
                    ctx.restore();
                },
                afterDatasetsDraw: function (chart) {
                    if (!chart.options.isExporting && !chart.isExporting) return;
                    var ctx = chart.ctx;
                    ctx.save();
                    ctx.font = 'bold 11px Inter';
                    ctx.fillStyle = state.darkMode ? '#e6edf3' : '#1f2328';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    chart.data.datasets.forEach(function (dataset, i) {
                        var meta = chart.getDatasetMeta(i);
                        meta.data.forEach(function (bar, index) {
                            var data = dataset.data[index];
                            if (data > 0) ctx.fillText(data, bar.x + 6, bar.y);
                        });
                    });
                    ctx.restore();
                }
            }]
        });
        } catch (e) { adicionarLog('Erro renderChartTop: ' + e.message, 'error'); }
    }

    // ================================================================
    // TABLE
    // ================================================================
    function renderTabela(dados) {
        try {
        var tbody = document.getElementById('eproc-table-body');
        if (!tbody) return;
        var busca = (document.getElementById('eproc-tabela-busca').value || '').toLowerCase();

        var dadosFiltrados = dados;
        if (busca) {
            dadosFiltrados = dados.filter(function (l) {
                var proc = String(l[1] || l.processo || '').toLowerCase();
                var regra = String(l[4] || l.regra || '');
                var data = String(l[2] || l.dataOnly || l.data || '');
                return proc.indexOf(busca) !== -1 || regra.indexOf(busca) !== -1 || data.indexOf(busca) !== -1;
            });
        }

        // Agrupa por Regra apenas (sem Data e sem agrupar por Grupo redundante)
        var agregado = {};
        dadosFiltrados.forEach(function (l) {
            var regra = l[4] || l.regra || '';
            var rk = String(regra).trim();
            var ri = state.regrasMap.get(rk);
            var grupo = ri ? ri.grupo : 'Não Classificado';
            var chave = rk;
            if (!agregado[chave]) {
                agregado[chave] = { regra: rk, grupo: grupo, processos: [], count: 0 };
            }
            agregado[chave].count++;
            agregado[chave].processos.push({
                numero: l[1] || l.processo || '',
                url: l[7] || l.processoUrl || '',
                dataCompleta: l[2] || l.dataOnly || l.data || '',
                hora: l[3] || l.hora || '' // Adiciona o horário
            });
        });
        state.tabelaAgregada = agregado;

        var linhas = Object.values(agregado);

        // Sort das linhas agrupadas
        var sk = state.tabelaSort || 'regra'; // Ordenação padrão por Regra
        var asc = state.tabelaSortDirAsc !== false;

        linhas.sort(function (a, b) {
            var va, vb;
            if (sk === 'regra') {
                va = String(a.regra || '').toLowerCase();
                vb = String(b.regra || '').toLowerCase();
                return asc ? va.localeCompare(vb, undefined, { numeric: true }) : vb.localeCompare(va, undefined, { numeric: true });
            } else if (sk === 'grupo') {
                va = String(a.grupo || '').toLowerCase();
                vb = String(b.grupo || '').toLowerCase();
                return asc ? va.localeCompare(vb, undefined, { numeric: true }) : vb.localeCompare(va, undefined, { numeric: true });
            } else if (sk === 'qtd') {
                va = a.count; vb = b.count;
                if (va < vb) return asc ? -1 : 1;
                if (va > vb) return asc ? 1 : -1;
                return 0;
            } else if (sk === 'processo') {
                va = a.processos[0] ? String(a.processos[0].numero) : '';
                vb = b.processos[0] ? String(b.processos[0].numero) : '';
                return asc ? va.localeCompare(vb, undefined, { numeric: true }) : vb.localeCompare(va, undefined, { numeric: true });
            } else {
                return 0;
            }
        });

        var totalPag = Math.ceil(linhas.length / tabelaPagSize) || 1;
        if (tabelaPagina >= totalPag) tabelaPagina = totalPag - 1;
        if (tabelaPagina < 0) tabelaPagina = 0;
        var inicio = tabelaPagina * tabelaPagSize;
        var pagina = linhas.slice(inicio, inicio + tabelaPagSize);

        tbody.innerHTML = pagina.map(function (linha) {
            return '<tr>' +
                '<td class="regra-num">' + escHTML(linha.regra) + '</td>' +
                '<td>' + escHTML(linha.grupo) + '</td>' +
                '<td class="val">' + fmtNumero(linha.count) + '</td>' +
                '<td class="proc-cell">' + (state.exibirProcessos && linha.processos.length > 0 ?
                    linha.processos.slice(0, 3).map(function (p) {
                        if (p.url) return '<a href="' + escHTML(p.url) + '" target="_blank">' + escHTML(p.numero) + '</a>';
                        return escHTML(p.numero);
                    }).join(', ') + (linha.processos.length > 3 ? ' <span class="ver-mais-processos" data-regra="' + escHTML(linha.regra) + '" style="cursor: pointer; text-decoration: underline; font-weight: 500;">(+' + (linha.processos.length - 3) + ')</span>' : '')
                    : '—') + '</td>' +
                '</tr>';
        }).join('');

        document.getElementById('eproc-table-info').textContent =
            fmtNumero(linhas.length) + ' regras' + (busca ? ' (filtradas)' : '');

        // Pagination
        var pagesEl = document.getElementById('eproc-table-pages');
        if (totalPag <= 1) { pagesEl.innerHTML = ''; return; }

        var start = Math.max(0, tabelaPagina - 3);
        var end = Math.min(totalPag, start + 8);
        if (end - start < 8) start = Math.max(0, end - 8);

        var pagesHtml = '';
        if (tabelaPagina > 0) {
            pagesHtml += '<span data-page="0" title="Primeira">«</span>';
            pagesHtml += '<span data-page="' + (tabelaPagina - 1) + '">‹</span>';
        }

        for (var p = start; p < end; p++) {
            pagesHtml += '<span data-page="' + p + '"' + (p === tabelaPagina ? ' class="active"' : '') + '>' + (p + 1) + '</span>';
        }

        if (tabelaPagina < totalPag - 1) {
            pagesHtml += '<span data-page="' + (tabelaPagina + 1) + '">›</span>';
            pagesHtml += '<span data-page="' + (totalPag - 1) + '" title="Última">»</span>';
        }
        pagesEl.innerHTML = pagesHtml;
        pagesEl.querySelectorAll('span').forEach(function (el) {
            el.onclick = function () {
                tabelaPagina = parseInt(this.dataset.page);
                renderTabela(dados);
            };
        });
        } catch (e) { adicionarLog('Erro renderTabela: ' + e.message, 'error'); }
    }

    // ================================================================
    // PROCESS LIST (bottom right overlay)
    // ================================================================
    function parseDataBR(str) {
        if (!str) return new Date(0);
        var partesEspaco = String(str).trim().split(' ');
        var partesData = partesEspaco[0].split('/');
        if (partesData.length === 3) {
            var ano = parseInt(partesData[2], 10);
            var mes = parseInt(partesData[1], 10) - 1;
            var dia = parseInt(partesData[0], 10);
            var hh = 12, mm = 0, ss = 0;
            if (partesEspaco[1]) {
                var partesHora = partesEspaco[1].split(':');
                hh = parseInt(partesHora[0], 10) || 0;
                mm = parseInt(partesHora[1], 10) || 0;
                ss = parseInt(partesHora[2], 10) || 0;
            }
            return new Date(ano, mes, dia, hh, mm, ss);
        }
        var d2 = new Date(str);
        return isNaN(d2) ? new Date(0) : d2;
    }

    function abrirListaProcessosDaLinha(regra, processos) {
        var overlay = document.getElementById('eproc-processos-overlay');
        var body = document.getElementById('eproc-pl-body');
        var count = document.getElementById('eproc-pl-count');
        var headerSpan = overlay.querySelector('.pl-header span');
        if (!overlay || !body) return;

        if (headerSpan) {
            headerSpan.textContent = '📋 Processos - Regra ' + regra;
        }

        // Ordena por ordem cronológica crescente (antigo -> recente)
        var processosOrdenados = processos.slice().sort(function (a, b) {
            var horaA = a.hora || '';
            var horaB = b.hora || '';
            return parseDataBR(a.dataCompleta + ' ' + horaA).getTime() - parseDataBR(b.dataCompleta + ' ' + horaB).getTime();
        });

        body.innerHTML = processosOrdenados.map(function (p) {
            var num = p.numero || '';
            var url = p.url || '';
            var dataFormatada = p.dataCompleta ? fmtDataBR(p.dataCompleta) : '';
            var horaFormatada = p.hora ? fmtHoraBR(p.hora) : '';
            var dataHora = (dataFormatada && horaFormatada) ? (dataFormatada + ' às ' + horaFormatada) : (dataFormatada || horaFormatada || '—');
            var linkHtml = url ?
                '<a href="' + escHTML(url) + '" target="_blank">' + escHTML(num) + '</a>' :
                escHTML(num);
            return '<div class="pl-item"><span class="pl-proc">' + linkHtml + '</span><span class="pl-meta">' + escHTML(dataHora) + '</span></div>';
        }).join('');

        count.textContent = fmtNumero(processosOrdenados.length) + ' processo' + (processosOrdenados.length !== 1 ? 's' : '');
        overlay.classList.add('active');
    }

    function abrirListaProcessos() {
        var overlay = document.getElementById('eproc-processos-overlay');
        var body = document.getElementById('eproc-pl-body');
        var count = document.getElementById('eproc-pl-count');
        var headerSpan = overlay.querySelector('.pl-header span');
        if (!overlay || !body) return;

        if (headerSpan) {
            headerSpan.textContent = '📋 Todos os Processos';
        }

        var dados = state.dadosFiltrados || [];
        if (dados.length === 0) {
            body.innerHTML = '<div style="padding:20px;text-align:center;color:#484f58;font-size:11px;">Nenhum processo para exibir.</div>';
            count.textContent = '0 processos';
            overlay.classList.add('active');
            return;
        }

        // Ordena por ordem cronológica crescente (antigo -> recente)
        var dadosOrdenados = dados.slice().sort(function (a, b) {
            var da = a[2] || a.dataOnly || a.data || '';
            var db = b[2] || b.dataOnly || b.data || '';
            var ha = a[3] || a.hora || '';
            var hb = b[3] || b.hora || '';
            return parseDataBR(da + ' ' + ha).getTime() - parseDataBR(db + ' ' + hb).getTime();
        });

        body.innerHTML = dadosOrdenados.map(function (l) {
            var proc = l[1] || l.processo || '';
            var dataVal = l[2] || l.dataOnly || l.data || '';
            var horaVal = l[3] || l.hora || '';
            var dataFormatada = fmtDataBR(dataVal);
            var horaFormatada = fmtHoraBR(horaVal);
            var dataHora = (dataFormatada && horaFormatada) ? (dataFormatada + ' às ' + horaFormatada) : (dataFormatada || horaFormatada || '—');
            var regra = l[4] || l.regra || '';
            var url = l[7] || l.processoUrl || '';
            var linkHtml = url ?
                '<a href="' + escHTML(url) + '" target="_blank">' + escHTML(proc) + '</a>' :
                escHTML(proc);
            return '<div class="pl-item"><span class="pl-proc">' + linkHtml + '</span><span class="pl-meta">Regra ' + escHTML(regra) + ' · ' + escHTML(dataHora) + '</span></div>';
        }).join('');

        count.textContent = fmtNumero(dadosOrdenados.length) + ' processo' + (dadosOrdenados.length !== 1 ? 's' : '');
        overlay.classList.add('active');
    }

    // ================================================================
    // GLOSSARY
    // ================================================================
    function mostrarGlossario(regraId) {
        var box = document.getElementById('eproc-glossario-box');
        if (!regraId) { box.style.display = 'none'; return; }
        var info = state.regrasMap.get(regraId);
        if (!info) { box.style.display = 'none'; return; }
        box.style.display = 'block';
        box.innerHTML =
            '<div class="g-title">Regra ' + escHTML(regraId) + '</div>' +
            (info.grupo ? '<div class="g-row"><span class="g-label">📍 Grupo:</span><span class="g-value">' + escHTML(info.grupo) + '</span></div>' : '') +
            (info.origem ? '<div class="g-row"><span class="g-label">📍 Origem:</span><span class="g-value">' + escHTML(info.origem) + '</span></div>' : '') +
            (info.controle ? '<div class="g-row"><span class="g-label">🎯 Controle:</span><span class="g-value">' + escHTML(info.controle) + '</span></div>' : '') +
            (info.destino ? '<div class="g-row"><span class="g-label">📌 Destino:</span><span class="g-value">' + escHTML(info.destino) + '</span></div>' : '') +
            (info.outros ? '<div class="g-row"><span class="g-label">📎 Outros:</span><span class="g-value">' + escHTML(info.outros) + '</span></div>' : '');
    }

    // ================================================================
    // EXPORT XLSX
    // ================================================================
    async function exportarXLSX() {
        var dados = state.dadosFiltrados;
        if (!dados || dados.length === 0) {
            adicionarLog('Nada para exportar', 'warn');
            return;
        }
        try {
            await carregarSheetJS();
        } catch (e) {
            adicionarLog('Erro ao carregar SheetJS: ' + e.message, 'error');
            return;
        }

        var data = [
            ['Data', 'Processo', 'Hora', 'Regra', 'Código Regra', 'Grupo', 'Origem', 'Controle', 'Destino', 'Link Processo']
        ];
        dados.forEach(function (l) {
            var rk = String(l[4] || l.regra || '').trim();
            var ri = state.regrasMap.get(rk) || {};
            var procNum = l[1] || l.processo || '';
            var procUrl = l[7] || l.processoUrl || '';
            data.push([
                fmtDataBR(l[2] || l.dataOnly || l.data || '').split(' ')[0],
                procNum,
                l[3] || l.hora || '',
                l[4] || l.regra || '',
                l[5] || l.codRegra || '',
                ri.grupo || '',
                ri.origem || '',
                ri.controle || '',
                ri.destino || '',
                procUrl
            ]);
        });

        var wb = XLSX.utils.book_new();
        var wsDados = XLSX.utils.aoa_to_sheet(data);

        var deltaExec = document.getElementById('kpi-exec-delta') ? document.getElementById('kpi-exec-delta').textContent : '';
        var deltaProc = document.getElementById('kpi-proc-delta') ? document.getElementById('kpi-proc-delta').textContent : '';

        var dataRel = [
            ['PROJETO LOGS EPROC - RELATÓRIO DE AUDITORIA E DESEMPENHO'],
            ['Gerado em: ' + new Date().toLocaleString('pt-BR')],
            [],
            ['MÉTRICAS GLOBAIS DE DESEMPENHO'],
            ['Período de Análise', (state.filters.dataInicio ? fmtDataBR(state.filters.dataInicio).split(' ')[0] : 'Início') + ' a ' + (state.filters.dataFim ? fmtDataBR(state.filters.dataFim).split(' ')[0] : 'Fim'), ''],
            ['Total de Execuções', parseInt(document.getElementById('kpi-exec').textContent.replace(/\./g, '')) || 0, deltaExec || 'Sem dados de variação'],
            ['Média de Execuções / Dia', parseInt(document.getElementById('kpi-media-exec').textContent.replace(/\./g, '')) || 0, ''],
            ['Total de Processos Impactados', parseInt(document.getElementById('kpi-proc').textContent.replace(/\./g, '')) || 0, deltaProc || 'Sem dados de variação'],
            ['Média de Processos / Dia', parseInt(document.getElementById('kpi-media-proc').textContent.replace(/\./g, '')) || 0, '']
        ];

        var procAg = {};
        dados.forEach(function (l) {
            var proc = l[1] || l.processo || '';
            if (proc) {
                procAg[proc] = (procAg[proc] || 0) + 1;
            }
        });
        var procsSorted = Object.entries(procAg).sort(function (a, b) { return b[1] - a[1]; });
        
        dataRel.push([]);
        dataRel.push(['DISTRIBUIÇÃO ANALÍTICA POR GRUPO DE REGRA']);
        dataRel.push(['Grupo de Regra', 'Execuções', 'Processos Impactados']);
        var gruposAg = {};
        dados.forEach(function (l) {
            var ri = state.regrasMap.get(String(l[4] || l.regra || '').trim()) || {};
            var g = ri.grupo || 'Sem Grupo';
            var proc = l[1] || l.processo || '';
            if (!gruposAg[g]) {
                gruposAg[g] = { exec: 0, procs: new Set() };
            }
            gruposAg[g].exec++;
            gruposAg[g].procs.add(proc);
        });
        Object.entries(gruposAg).sort(function (a, b) { return b[1].exec - a[1].exec; }).forEach(function (e) {
            dataRel.push([e[0], e[1].exec, e[1].procs.size]);
        });
        dataRel.push([]);
        dataRel.push(['DISTRIBUIÇÃO ANALÍTICA POR REGRA DE AUTOMAÇÃO']);
        dataRel.push(['Identificação da Regra', 'Execuções', 'Processos Impactados']);
        var regrasAg = {};
        dados.forEach(function (l) {
            var r = 'Regra ' + (l[4] || l.regra || '?');
            var proc = l[1] || l.processo || '';
            if (!regrasAg[r]) {
                regrasAg[r] = { exec: 0, procs: new Set() };
            }
            regrasAg[r].exec++;
            regrasAg[r].procs.add(proc);
        });
        Object.entries(regrasAg).sort(function (a, b) { return b[1].exec - a[1].exec; }).forEach(function (e) {
            dataRel.push([e[0], e[1].exec, e[1].procs.size]);
        });

        dataRel.push([]);
        dataRel.push(['TOP 10 PROCESSOS COM MAIS EXECUÇÕES']);
        dataRel.push(['Processo', 'Execuções', '']);
        procsSorted.slice(0, 10).forEach(function (e) {
            dataRel.push([e[0], e[1], '']);
        });

        dataRel.push([]);
        dataRel.push(['TOP 10 PROCESSOS COM MENOS EXECUÇÕES']);
        dataRel.push(['Processo', 'Execuções', '']);
        procsSorted.slice(-10).reverse().forEach(function (e) {
            dataRel.push([e[0], e[1], '']);
        });

        var wsRel = XLSX.utils.aoa_to_sheet(dataRel);

        // Define larguras automáticas elegantes de colunas nas abas
        wsDados['!cols'] = [
            { wch: 12 }, // Data
            { wch: 22 }, // Processo
            { wch: 10 }, // Hora
            { wch: 22 }, // Regra
            { wch: 15 }, // Código Regra
            { wch: 20 }, // Grupo
            { wch: 15 }, // Origem
            { wch: 15 }, // Controle
            { wch: 15 }, // Destino
            { wch: 50 }  // Link Processo
        ];

        wsRel['!cols'] = [
            { wch: 35 }, // Indicador / Grupo / Regra
            { wch: 25 }, // Valor / Execuções
            { wch: 50 }  // Variação / Processos
        ];

        XLSX.utils.book_append_sheet(wb, wsRel, 'Relatórios');
        XLSX.utils.book_append_sheet(wb, wsDados, 'Dados');

        var wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        var blob = new Blob([wbout], { type: 'application/octet-stream' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'relatorio_logs_' + new Date().toISOString().slice(0, 10) + '.xlsx';
        link.click();
        URL.revokeObjectURL(link.href);
        adicionarLog('XLSX exportado: ' + fmtNumero(dados.length) + ' registros', 'success');
    }

    // ================================================================
    // ALERTA DE PAGINACAO INSUFICIENTE
    // Exibe um banner verde caso a paginacao da tabela nao seja 1000
    // ================================================================
    function verificarPaginacao() {
        // Tenta ler o seletor de itens por pagina do DataTables (EPROC)
        var sel = document.querySelector('#tableAutomatizacaoLocalizadores_length select') ||
                  document.querySelector('select[name="tableAutomatizacaoLocalizadores_length"]') ||
                  document.querySelector('.dataTables_length select');

        var valorAtual = sel ? parseInt(sel.value, 10) : null;

        // Se ja esta em 1000 ou nao conseguiu detectar, nao exibe nada
        if (!sel || valorAtual === 1000) return;

        // Verifica se o banner ja existe para nao duplicar
        if (document.getElementById('eproc-paginacao-alerta')) return;

        var banner = document.createElement('div');
        banner.id = 'eproc-paginacao-alerta';
        banner.style.cssText = [
            'position: fixed',
            'bottom: 24px',
            'left: 50%',
            'transform: translateX(-50%)',
            'z-index: 9999999',
            'background: linear-gradient(135deg, #16a34a, #22c55e)',
            'color: #ffffff',
            'font-weight: bold',
            'font-family: Inter, -apple-system, sans-serif',
            'font-size: 13px',
            'padding: 14px 28px',
            'border-radius: 12px',
            'box-shadow: 0 4px 24px rgba(22, 163, 74, 0.45)',
            'border: 1px solid rgba(255,255,255,0.2)',
            'display: flex',
            'align-items: center',
            'gap: 12px',
            'max-width: 90vw',
            'text-align: center',
            'animation: eproc-slide-up 0.4s cubic-bezier(0.34,1.56,0.64,1) both'
        ].join('; ');

        // Injeta animacao de entrada
        if (!document.getElementById('eproc-paginacao-alerta-css')) {
            var styleEl = document.createElement('style');
            styleEl.id = 'eproc-paginacao-alerta-css';
            styleEl.textContent = '@keyframes eproc-slide-up { from { opacity:0; transform:translateX(-50%) translateY(20px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }';
            document.head.appendChild(styleEl);
        }

        banner.innerHTML =
            '<span style="font-size:20px;">⚠️</span>' +
            '<span>Por favor, para garantir o correto funcionamento do sistema de estatísticas de Logs, ' +
            'altere a paginação para <u>1000 Regras</u>.' +
            ' (Atual: <strong>' + (valorAtual || 'desconhecido') + '</strong>)</span>' +
            '<button id="eproc-paginacao-alerta-fechar" style="' +
            'background:rgba(255,255,255,0.25); border:none; color:#fff; font-size:16px; ' +
            'cursor:pointer; border-radius:6px; padding:2px 8px; margin-left:6px; line-height:1; font-weight:bold;' +
            '" title="Fechar">✕</button>';

        document.body.appendChild(banner);

        document.getElementById('eproc-paginacao-alerta-fechar').onclick = function () {
            var b = document.getElementById('eproc-paginacao-alerta');
            if (b) {
                b.style.animation = 'none';
                b.style.opacity = '0';
                b.style.transform = 'translateX(-50%) translateY(20px)';
                b.style.transition = 'opacity 0.3s, transform 0.3s';
                setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 350);
            }
        };

        adicionarLog('AVISO: Paginacao atual (' + valorAtual + ') menor que 1000. Altere para garantir extracao completa.', 'warn');
    }

    // ================================================================
    // INIT
    // ================================================================
    state.darkMode = String(GM_getValue('darkMode', 'false')) === 'true';

    function aguardarJQuery(cb, t) {
        t = t || 0;
        if (t > 20) return;
        if (typeof jQuery !== 'undefined' && $('#tableAutomatizacaoLocalizadores').length) cb();
        else setTimeout(function () { aguardarJQuery(cb, t + 1); }, 500);
    }

    aguardarJQuery(async function () {
        if (!PERFIL_ATUAL) {
            alert('Erro: O painel Eproc Logs não conseguiu identificar o seu perfil de usuário atual. A extração foi bloqueada para evitar inconsistências. Por favor, recarregue a página ou verifique sua lotação.');
            return;
        }

        criarUI();

        // Verifica paginacao e exibe alerta se necessario
        verificarPaginacao();

        var n = extrairRegras().length;
        adicionarLog(n + ' regras encontradas na pagina', 'info');

        // Auto-import silencioso se estiver desatualizado
        try {
            if (atualizarStatusExtracao() === 'desatualizado') {
                state.silentMode = true;
                iniciarImportacao();
            }
        } catch (e) {
            adicionarLog('[auto] Erro ao iniciar extra\u00E7\u00E3o autom\u00E1tica: ' + e.message, 'error');
        }

        // Processa dados pr\u00E9-carregados em segundo plano
        if (_earlyDadosPromise) {
            _earlyDadosPromise.then(function (dados) {
                _earlyDadosPromise = null;
                if (dados) processarDadosHelper(dados);
            }).catch(function () {
                _earlyDadosPromise = null;
            });
        }

        // Verifica a cada 60s se passou 30min sem extrair
        setInterval(function() {
            if (!state.processando && atualizarStatusExtracao() === 'desatualizado') {
                state.silentMode = true;
                iniciarImportacao();
            }
        }, 60000);

        // Detecta troca de perfil (dropdown de lota\u00E7\u00E3o)
        var selLotacao = document.getElementById('selLotacao');
        if (selLotacao) {
            selLotacao.addEventListener('change', function() {
                var novoPerfil = detectarPerfilUsuario();
                if (novoPerfil && novoPerfil !== PERFIL_ATUAL) {
                    PERFIL_ATUAL = novoPerfil;
                    state.perfilAtual = novoPerfil;
                    state.ultimaExtracao = GM_getValue('ultimaExtracao_' + novoPerfil, null);
                    atualizarBadgeExtracao();
                    if (!state.processando && atualizarStatusExtracao() === 'desatualizado') {
                        state.silentMode = true;
                        iniciarImportacao();
                    }
                }
            });
        }

        // Processa dados pré-carregados em segundo plano
        if (_earlyDadosPromise) {
            _earlyDadosPromise.then(function (dados) {
                _earlyDadosPromise = null;
                if (dados) processarDadosHelper(dados);
            }).catch(function () {
                _earlyDadosPromise = null;
            });
        }
    });

})();
