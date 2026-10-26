import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './safety.css';
import './device-view.css';
import './theme.css';
import './report.css';
import './motion.css';
const DeviceViewer = lazy(() => import('./DeviceViewer.jsx'));

const paths = {
  pulse: 'M2 12h4l2.2-7 4.1 14 2.6-7H22',
  grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  watch: 'M8 2h8v20H8z M10 5h4 M10 19h4',
  heart: 'M20.8 8.8c0 5.5-8.8 10.2-8.8 10.2S3.2 14.3 3.2 8.8a4.8 4.8 0 0 1 8.8-2.6 4.8 4.8 0 0 1 8.8 2.6ZM4 12h4l2-3 3.5 6 2-3H20',
  drop: 'M12 3s7 7 7 12a7 7 0 0 1-14 0c0-5 7-12 7-12Z M9 16a3 3 0 0 0 3 3',
  bell: 'M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  check: 'm5 12 4 4L19 6',
  arrow: 'M7 17 17 7M7 7h10v10',
};

function Icon({ name, size = 19 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.pulse} /></svg>;
}

function DeviceView({ theme, onToggleTheme }) {
  const [reading, setReading] = useState(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const response = await fetch('/api/data?limit=1');
        if (!response.ok) return;
        const rows = await response.json();
        if (live && rows[0]) setReading(rows[0]);
      } catch { /* Keep the viewer available when the receiver is offline. */ }
    };
    load(); const timer = setInterval(load, 2500);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const payload = reading?.data || {};
  const bpm = val(payload.heartRate ?? payload.heartbeat);
  const oxygen = val(payload.spo2 ?? payload.SpO2);
  const deviceName = payload.deviceId || reading?.deviceId || 'Pulse health band';
  return <main className="device-view-page">
    <header className="device-view-top"><a className="device-view-brand" href="/"><span className="brand-icon"><Icon name="pulse" size={20}/></span>pulse<span>.</span></a><div className="device-header-actions"><button className="theme-toggle" onClick={onToggleTheme} aria-label={`Switch to ${theme==='dark'?'light':'dark'} mode`} title={`Switch to ${theme==='dark'?'light':'dark'} mode`}>{theme==='dark'?'☀':'☾'}<span>{theme==='dark'?'Light':'Dark'} mode</span></button><a className="device-back" href="/">← Back to dashboard</a></div></header>
    <section className="device-view-intro"><p className="overline">INTERACTIVE DEVICE VIEW</p><h1>Explore your health band<span>✦</span></h1><p>Rotate the whole device, inspect individual parts, or pull it apart to see how it fits together.</p></section>
    <Suspense fallback={<div className="true-viewer-stage viewer-loading">Preparing the 3D device model…</div>}><DeviceViewer theme={theme} heartRate={bpm} spo2={oxygen} time={new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}/></Suspense>
    <section className="device-view-info"><div><span className="info-icon">⌚</span><span><small>CONNECTED DEVICE</small><b>{deviceName}</b></span></div><div><span className="info-icon heart-info">♥</span><span><small>HEART RATE</small><b>{bpm === null ? 'Waiting for data' : `${bpm} bpm`}</b></span></div><div><span className="info-icon oxygen-info">◉</span><span><small>OXYGEN SATURATION</small><b>{oxygen === null ? 'Waiting for data' : `${oxygen}%`}</b></span></div></section>
    <p className="device-view-note">The readings shown update automatically from the latest data received by your dashboard.</p>
  </main>;
}

function Sparkline({ values = [], large = false }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const w = 400, h = large ? 174 : 54, pad = large ? 10 : 5;
  const entries = values.map((item) => typeof item === 'number' ? { value: item } : item);
  const list = entries.length > 1 ? entries : entries.length ? [entries[0], entries[0]] : [{ value: 0 }, { value: 0 }];
  const low = Math.min(...list.map((item) => item.value)), span = Math.max(...list.map((item) => item.value)) - low || 1;
  const pts = list.map((item, i) => [pad + i / (list.length - 1) * (w - pad * 2), h - pad - (item.value - low) / span * (h - pad * 2)]);
  const line = pts.map(([x,y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts.at(-1)[0]} ${h} L${pts[0][0]} ${h} Z`;
  const moveToPoint = (event) => {
    if (!large || !entries.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const index = Math.round(ratio * (entries.length - 1));
    setHoverIndex(index);
  };
  const stepPoint = (event) => {
    if (!large || !entries.length) return;
    if (event.key === 'Escape') { setHoverIndex(null); return; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setHoverIndex((current) => Math.min(entries.length - 1, Math.max(0, (current ?? entries.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1))));
    }
  };
  const selected = large && entries.length && hoverIndex !== null ? hoverIndex : null;
  const selectedPoint = selected === null ? null : entries[selected];
  const selectedCoords = selected === null ? null : pts[selected];
  const tooltipLeft = selectedCoords ? Math.min(80, Math.max(20, selectedCoords[0] / w * 100)) : 0;
  const tooltipTop = selectedCoords ? Math.min(80, Math.max(36, selectedCoords[1] / h * 100)) : 0;
  return <div className={`sparkline-wrap ${large ? 'large' : ''}`} onPointerMove={moveToPoint} onPointerLeave={() => large && setHoverIndex(null)} onPointerDown={moveToPoint} onKeyDown={stepPoint} tabIndex={large ? 0 : undefined} role={large ? 'group' : undefined} aria-label={large ? 'Interactive heart rate chart. Use left and right arrow keys to inspect readings.' : undefined}>
    <svg className={large ? 'sparkline large' : 'sparkline'} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {large && [0.25, 0.5, 0.75].map((v) => <line key={v} className="chart-grid" x1="0" x2={w} y1={h*v} y2={h*v} />)}
      <path d={area} fill="rgba(119,103,231,.11)" /><path d={line} className="chart-line" />
      {selectedCoords && hoverIndex !== null && <line className="chart-crosshair" x1={selectedCoords[0]} x2={selectedCoords[0]} y1={pad} y2={h} />}
      <circle className="chart-dot" cx={selectedCoords?.[0] ?? pts.at(-1)[0]} cy={selectedCoords?.[1] ?? pts.at(-1)[1]} r={large ? (hoverIndex === null ? 4 : 6) : 3} />
    </svg>
    {selectedPoint && <div className="chart-tooltip" style={{ left: `${tooltipLeft}%`, top: `${tooltipTop}%` }}>
      <strong>{selectedPoint.value}<small> bpm</small></strong>
      <span>{selectedPoint.receivedAt ? new Date(selectedPoint.receivedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Reading'}</span>
      {selectedPoint.spo2 !== null && selectedPoint.spo2 !== undefined && <span>SpO₂ {selectedPoint.spo2}%</span>}
      {selectedPoint.sample && <em>Example reading</em>}
    </div>}
  </div>;
}

const val = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
const fmtTime = (v) => v ? new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const ago = (v, now) => {
  if (!v) return 'Waiting for first reading';
  const seconds = Math.max(0, Math.floor((now - new Date(v).getTime()) / 1000));
  return seconds < 10 ? 'Just now' : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
};

function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('pulse-theme') === 'dark' ? 'dark' : 'light');
  const [events, setEvents] = useState([]);
  const [motionFeed, setMotionFeed] = useState(null);
  const [motionFeedError, setMotionFeedError] = useState('');
  const [totalReadings, setTotalReadings] = useState(0);
  const [dbState, setDbState] = useState('checking');
  const [now, setNow] = useState(Date.now());
  const [period, setPeriod] = useState('Today');
  const [deviceMenu, setDeviceMenu] = useState(false);
  const [profileMenu, setProfileMenu] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [safety, setSafety] = useState(null);
  const [safetyError, setSafetyError] = useState('');
  const [safetyKey, setSafetyKey] = useState('');
  const [guardianForm, setGuardianForm] = useState({ name: '', relation: 'Parent', phone: '', consent: false });
  const [safetyRules, setSafetyRules] = useState({ heartRateLow: 40, heartRateHigh: 130, spo2Low: 92 });
  const [safetyBusy, setSafetyBusy] = useState(false);
  const [reportPeriod, setReportPeriod] = useState('week');
  const [reportStatus, setReportStatus] = useState({ configured: null, unavailable: false, model: '' });
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState('');
  const [reportResult, setReportResult] = useState(null);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('pulse-theme', theme); }, [theme]);
  const toggleTheme = () => setTheme((current) => current === 'dark' ? 'light' : 'dark');

  const refreshData = useCallback(async () => {
    try {
      const [dataRes, healthRes, statsRes] = await Promise.all([fetch('/api/data?limit=100'), fetch('/health'), fetch('/api/stats')]);
      if (!dataRes.ok || !healthRes.ok || !statsRes.ok) throw new Error('server unavailable');
      const [data, health, stats] = await Promise.all([dataRes.json(), healthRes.json(), statsRes.json()]);
      setEvents(Array.isArray(data) ? data : []); setTotalReadings(stats.totalReadings || 0); setDbState(health.database === 'connected' ? 'connected' : 'offline');
    } catch { setDbState('offline'); }
  }, []);

  useEffect(() => {
    refreshData(); const poll = setInterval(refreshData, 2500); const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [refreshData]);

  const loadSafetyCenter = useCallback(async () => {
    try {
      let key = sessionStorage.getItem('pulse-dashboard-key');
      if (!key) {
        const keyRes = await fetch('/api/session-key');
        if (!keyRes.ok) throw new Error('For privacy, open this page at http://localhost:3000 on the computer running the dashboard to manage guardian numbers.');
        key = (await keyRes.json()).key;
        sessionStorage.setItem('pulse-dashboard-key', key);
      }
      const response = await fetch('/api/safety-center', { headers: { 'x-dashboard-key': key } });
      if (!response.ok) throw new Error('Could not load saved safety contacts. Refresh the dashboard and try again.');
      const data = await response.json();
      setSafety(data); setSafetyRules({ heartRateLow: data.rules.heartRateLow, heartRateHigh: data.rules.heartRateHigh, spo2Low: data.rules.spo2Low }); setSafetyKey(key); setSafetyError('');
    } catch (error) { setSafetyError(error.message); }
  }, []);

  useEffect(() => { loadSafetyCenter(); }, [loadSafetyCenter]);

  useEffect(() => {
    if (!safetyKey) return undefined;
    let live = true;
    const loadMotionPredictions = async () => {
      try {
        const response = await fetch('/api/motion/predictions?limit=8', { headers: { 'x-dashboard-key': safetyKey } });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || 'Could not load motion analysis.');
        if (live) { setMotionFeed(result); setMotionFeedError(''); }
      } catch (error) {
        if (live) setMotionFeedError(error.message);
      }
    };
    loadMotionPredictions();
    const timer = setInterval(loadMotionPredictions, 500);
    return () => { live = false; clearInterval(timer); };
  }, [safetyKey]);

  useEffect(() => {
    fetch('/api/reports/status').then((response) => {
      if (!response.ok) throw new Error('Report API unavailable');
      return response.json();
    }).then((status) => setReportStatus({ ...status, unavailable: false }))
      .catch(() => setReportStatus({ configured: false, unavailable: true, model: '' }));
  }, []);

  const generateReport = async () => {
    setReportBusy(true); setReportError('');
    try {
      const response = await fetch('/api/reports/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-key': safetyKey }, body: JSON.stringify({ period: reportPeriod }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Could not generate the report.');
      setReportResult(result);
    } catch (error) { setReportError(error.message); }
    finally { setReportBusy(false); }
  };

  const downloadReportDoc = () => {
    if (!reportResult) return;
    const escapeHtml = (value) => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    const dailyRows = (reportResult.daily || []).map((day) => `<tr><td>${escapeHtml(day.date)}</td><td>${day.readingCount}</td><td>${escapeHtml(day.heartRate.averageBpm)} bpm</td><td>${escapeHtml(day.heartRate.minBpm)} bpm</td><td>${escapeHtml(day.heartRate.maxBpm)} bpm</td><td>${escapeHtml(day.spo2.averagePercent)}%</td><td>${escapeHtml(day.spo2.minPercent)}–${escapeHtml(day.spo2.maxPercent)}%</td><td>${day.fallFlags}</td><td>HR ${day.heartRate.missingOrInvalid}; SpO₂ ${day.spo2.missingOrInvalid}${day.readingCount === 0 ? '; no readings today' : ''}</td></tr>`).join('');
    const metrics = reportResult.metrics;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pulse ${reportResult.period} report</title><style>body{font:11pt Arial,sans-serif;color:#24243a;margin:32px}h1{color:#5145b5}h2{margin-top:28px;color:#5145b5}p{line-height:1.5}.meta{color:#666}table{width:100%;border-collapse:collapse;font-size:9pt}th,td{border:1px solid #d8d7e2;padding:7px;text-align:left}th{background:#f0effa}pre{white-space:pre-wrap;font:10.5pt Arial,sans-serif;line-height:1.5}.disclaimer{margin-top:20px;color:#666;font-size:9pt}</style></head><body><h1>Pulse ${reportResult.period === 'week' ? 'Weekly' : 'Monthly'} Health Report</h1><p class="meta">Period: ${escapeHtml(new Date(reportResult.start).toLocaleDateString())} – ${escapeHtml(new Date(reportResult.end).toLocaleDateString())}<br>Generated: ${escapeHtml(new Date(reportResult.generatedAt).toLocaleString())}</p><h2>${reportResult.reportSource === 'calculated-fallback' ? 'Calculated summary (Gemini unavailable)' : 'AI summary'}</h2><pre>${escapeHtml(reportResult.report)}</pre><h2>Period totals</h2><p>Recorded readings: ${metrics.readings} · Days with readings: ${metrics.daysWithReadings}/${metrics.daysInPeriod} · Days with none: ${metrics.daysWithoutReadings}<br>Heart rate: average ${escapeHtml(metrics.heartRate.averageBpm)} bpm, minimum ${escapeHtml(metrics.heartRate.minBpm)} bpm, maximum ${escapeHtml(metrics.heartRate.maxBpm)} bpm; missing/invalid ${metrics.heartRate.missingOrInvalid} of ${metrics.readings} readings.<br>SpO₂: average ${escapeHtml(metrics.spo2.averagePercent)}%, minimum ${escapeHtml(metrics.spo2.minPercent)}%, maximum ${escapeHtml(metrics.spo2.maxPercent)}%; missing/invalid ${metrics.spo2.missingOrInvalid} of ${metrics.readings} readings.<br>Fall flags: ${metrics.fallFlags} · Critical flags: ${metrics.readingsFlaggedCritical}</p><h2>Daily breakdown</h2><table><thead><tr><th>Date</th><th>Readings</th><th>HR avg</th><th>HR min</th><th>HR max</th><th>SpO₂ avg</th><th>SpO₂ min–max</th><th>Fall flags</th><th>Missing data</th></tr></thead><tbody>${dailyRows}</tbody></table><p class="disclaimer">Informational summary only; not a diagnosis or medical advice. Wearable readings may be inaccurate. Fall flags are device-detected flags, not verified events. Missing/invalid counts are calculated per metric.</p></body></html>`;
    const blob = new Blob([html], { type: 'application/msword;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `pulse-${reportResult.period}-health-report.doc`; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const safetyRequest = async (url, options = {}) => {
    setSafetyBusy(true);
    try {
      const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'x-dashboard-key': safetyKey, ...(options.headers || {}) } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Could not save safety settings.');
      await loadSafetyCenter(); return result;
    } catch (error) { setSafetyError(error.message); throw error; }
    finally { setSafetyBusy(false); }
  };

  const addGuardian = async (event) => {
    event.preventDefault();
    try {
      await safetyRequest('/api/guardians', { method: 'POST', body: JSON.stringify(guardianForm) });
      setGuardianForm({ name: '', relation: 'Parent', phone: '', consent: false }); notify('Guardian contact saved');
    } catch { /* The inline safety message explains the issue. */ }
  };
  const saveSafetyRules = async (event) => {
    event.preventDefault();
    try { await safetyRequest('/api/safety-settings', { method: 'PUT', body: JSON.stringify(Object.fromEntries(Object.entries(safetyRules).map(([key, value]) => [key, Number(value)]))) }); notify('Alert limits saved'); }
    catch { /* The inline safety message explains the issue. */ }
  };

  const notify = (message) => { setToast(message); window.clearTimeout(notify.timer); notify.timer = window.setTimeout(() => setToast(''), 2600); };
  const copyEndpoint = async () => {
    try { await navigator.clipboard.writeText(`${window.location.origin}/api/data`); notify('Device endpoint copied'); }
    catch { notify('Copy unavailable — use /api/data on this address'); }
  };
  const exportCsv = () => {
    const columns = ['receivedAt', 'deviceId', 'heartRate', 'spo2', 'fallAlert', 'status', 'source', 'payload'];
    const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = events.map((event) => [event.receivedAt, event.data?.deviceId || event.deviceId, event.data?.heartRate ?? event.data?.heartbeat, event.data?.spo2 ?? event.data?.SpO2, event.data?.fallAlert ?? event.data?.fall_alert, event.data?.status, event.source || 'device', JSON.stringify(event.data)]);
    const blob = new Blob([[columns, ...rows].map((row) => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'pulse-readings.csv'; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDeviceMenu(false); notify(`Exported ${events.length} recent readings`);
  };

  const latest = events[0];
  const data = latest?.data || {};
  const heartRate = val(data.heartRate ?? data.heartbeat);
  const spo2 = val(data.spo2 ?? data.SpO2);
  const fall = Boolean(data.fallAlert ?? data.fall_alert);
  const trend = useMemo(() => {
    const days = period === 'Today' ? 1 : period === 'Week' ? 7 : 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const demoMode = events[0]?.source === 'demo';
    return events.filter((e) => (demoMode ? e.source === 'demo' : e.source !== 'demo') && new Date(e.receivedAt).getTime() >= cutoff).slice(0, 40).reverse()
      .map((e) => ({ value: val(e.data?.heartRate ?? e.data?.heartbeat), spo2: val(e.data?.spo2 ?? e.data?.SpO2), receivedAt: e.receivedAt, sample: e.source === 'demo' }))
      .filter((point) => point.value !== null);
  }, [events, period]);
  const avg = trend.length ? Math.round(trend.reduce((sum, point) => sum + point.value, 0) / trend.length) : null;
  const latestDeviceEvent = events.find((event) => event.source !== 'demo');
  const online = Boolean(latestDeviceEvent && now - new Date(latestDeviceEvent.receivedAt).getTime() < 45000);
  const device = data.deviceId || latest?.deviceId || 'Waiting for device';
  const latestMotion = motionFeed?.predictions?.[0] || null;
  const latestMotionFresh = Boolean(latestMotion && now - new Date(latestMotion.receivedAt).getTime() < 2500);
  const motionResult = latestMotion?.prediction;
  const motionAnalyzed = motionResult?.state === 'analyzed' && latestMotionFresh;
  const contextHeartRate = latestMotion?.vitalsContext?.heartRate ?? (latestMotion?.deviceId === device ? heartRate : null);
  const contextSpo2 = latestMotion?.vitalsContext?.spo2 ?? (latestMotion?.deviceId === device ? spo2 : null);
  const motionHoldout = motionFeed?.model?.holdoutEvaluation;
  const fallAlerts = events.filter((event) => Boolean(event.data?.fallAlert ?? event.data?.fall_alert));
  const isDemo = latest?.source === 'demo';

  if (window.location.pathname === '/device') return <DeviceView theme={theme} onToggleTheme={toggleTheme}/>;

  return <div className="layout">
    <aside className={`sidebar ${mobileNavOpen ? 'mobile-open' : ''}`}>
      <a className="brand" href="#top"><span className="brand-icon"><Icon name="pulse" size={21}/></span>pulse<span className="brand-dot">.</span></a>
      <div className="side-label">WORKSPACE</div>
      <div className="space-switch"><span className="space-avatar">C</span><span><b>Care space</b><small>Personal dashboard</small></span><i>⌄</i></div>
      <div className="side-label menu-label">MENU</div>
      <nav className="nav"><a className="nav-link chosen" href="#top" onClick={()=>setMobileNavOpen(false)}><Icon name="grid"/><span>Overview</span></a><a className="nav-link" href="#readings" onClick={()=>setMobileNavOpen(false)}><Icon name="pulse"/><span>Live readings</span><em>{events.length}</em></a><a className="nav-link" href="#reports" onClick={()=>setMobileNavOpen(false)}><Icon name="arrow"/><span>AI reports</span></a><a className="nav-link" href="/device" target="_blank" rel="noopener noreferrer" onClick={()=>setMobileNavOpen(false)}><Icon name="watch"/><span>My device</span></a></nav>
      <div className="sidebar-end"><div className="db-card"><span className="db-icon"><Icon name="check" size={17}/></span><span><b>{dbState === 'connected' ? 'All systems up' : dbState === 'checking' ? 'Connecting…' : 'Database offline'}</b><small>{dbState === 'connected' ? 'Local MongoDB' : 'Check local server'}</small></span><i className={`dot ${dbState === 'connected' ? 'green' : ''}`}/></div><div className="profile"><span className="avatar">P</span><span><b>Personal space</b><small>IoT monitoring</small></span><button aria-label="Profile options" aria-expanded={profileMenu} onClick={()=>setProfileMenu(!profileMenu)}>···</button>{profileMenu&&<div className="profile-popover"><strong>Personal dashboard</strong><small>Data is stored in local MongoDB.</small><button onClick={copyEndpoint}>Copy device endpoint</button><button onClick={()=>{refreshData();setProfileMenu(false);notify('Dashboard refreshed')}}>Refresh dashboard</button></div>}</div></div>
    </aside>
    {mobileNavOpen&&<button className="nav-backdrop" aria-label="Close navigation" onClick={()=>setMobileNavOpen(false)}/>}

    <main className="main" id="top">
      <header className="topbar"><button className="mobile-menu" aria-label="Menu" aria-expanded={mobileNavOpen} onClick={()=>setMobileNavOpen(!mobileNavOpen)}>☰</button><div className="crumb">Workspace <span>›</span> <b>Overview</b></div><div className="top-actions"><div className="connection"><i className={`dot ${online ? 'green blink' : ''}`}/>{online ? 'Device live' : 'Waiting for device'}</div><button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme==='dark'?'light':'dark'} mode`} title={`Switch to ${theme==='dark'?'light':'dark'} mode`}>{theme==='dark'?'☀':'☾'}<span>{theme==='dark'?'Light':'Dark'}</span></button><div className="popover-anchor"><button className="bell" aria-label="Notifications" aria-expanded={notificationsOpen} onClick={()=>setNotificationsOpen(!notificationsOpen)}><Icon name="bell" size={18}/>{fallAlerts.length>0&&<i/>}</button>{notificationsOpen&&<div className="notifications-popover"><strong>Notifications</strong>{fallAlerts.length?fallAlerts.slice(0,4).map((event)=><div className="notification-item" key={event.id}><span className="notification-alert"><Icon name="pulse" size={15}/></span><span><b>Fall alert</b><small>{event.data?.deviceId||event.deviceId} · {fmtTime(event.receivedAt)}</small></span></div>):<div className="no-alerts"><span><Icon name="check" size={17}/></span><b>You’re all caught up</b><small>No fall alerts in recent readings.</small></div>}</div>}</div><span className="avatar top-avatar">P</span></div></header>

      <section className="intro"><div><p className="overline">YOUR HEALTH, AT A GLANCE</p><h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'} <span>✦</span></h1><p>Here’s what’s happening with your connected device.</p></div><div className="date-card"><span>◷</span>{new Date().toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'})}<i/>{new Date(now).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div></section>

      {isDemo&&<div className="demo-banner"><span>i</span><span><b>Sample readings are displayed</b><small>These are example values to preview the dashboard. Incoming device data will appear here too.</small></span></div>}
      <section className="panel safety-panel" id="safety"><div className="panel-head"><div><p className="overline">FAMILY SAFETY</p><h2>Guardian contacts & WhatsApp alerts</h2></div><span className={`safety-badge ${safety?.whatsappConfigured?'ready':''}`}><i className={`dot ${safety?.whatsappConfigured?'green':''}`}/>{safety?.whatsappConfigured?'WhatsApp ready':'WhatsApp not configured'}</span></div>
        <p className="safety-copy">Add a parent or guardian who has agreed to receive an alert if the device detects a fall or a critical reading.</p>
        {safetyError&&<div className="safety-notice error">{safetyError}</div>}
        {safety&&<><div className="guardian-list">{safety.contacts.map((contact)=><div className="guardian-row" key={contact.id}><span className="guardian-avatar">{contact.name.slice(0,1).toUpperCase()}</span><span className="guardian-details"><b>{contact.name} <small>{contact.relation}</small></b><span>{contact.phone}</span></span><button className="remove-contact" disabled={safetyBusy} onClick={()=>safetyRequest(`/api/guardians/${contact.id}`, { method: 'DELETE' }).then(()=>notify('Guardian contact removed')).catch(()=>{})}>Remove</button></div>)}{!safety.contacts.length&&<div className="safety-empty">No guardians added yet. Add a trusted contact below.</div>}</div>
        <form className="guardian-form" onSubmit={addGuardian}><label>Name<input required maxLength="80" value={guardianForm.name} onChange={e=>setGuardianForm({...guardianForm,name:e.target.value})} placeholder="e.g. Alex Smith"/></label><label>Relationship<select value={guardianForm.relation} onChange={e=>setGuardianForm({...guardianForm,relation:e.target.value})}><option>Parent</option><option>Guardian</option><option>Family member</option><option>Caregiver</option><option>Other</option></select></label><label>WhatsApp number<input required type="tel" value={guardianForm.phone} onChange={e=>setGuardianForm({...guardianForm,phone:e.target.value})} placeholder="+919876543210"/><small>Include country code.</small></label><label className="consent-check"><input type="checkbox" required checked={guardianForm.consent} onChange={e=>setGuardianForm({...guardianForm,consent:e.target.checked})}/>This person agreed to receive WhatsApp safety alerts, which may include device readings.</label><button className="primary-button" disabled={safetyBusy || !safetyKey}>Add guardian</button></form>
        <form className="rules-form" onSubmit={saveSafetyRules}><div><b>Alert limits</b><small>Editable starter triggers; follow clinician guidance for personal limits.</small></div><label>Heart rate below<input type="number" min="25" max="70" value={safetyRules.heartRateLow} onChange={e=>setSafetyRules({...safetyRules,heartRateLow:e.target.value})}/>bpm</label><label>Heart rate above<input type="number" min="100" max="250" value={safetyRules.heartRateHigh} onChange={e=>setSafetyRules({...safetyRules,heartRateHigh:e.target.value})}/>bpm</label><label>SpO₂ at or below<input type="number" min="70" max="95" value={safetyRules.spo2Low} onChange={e=>setSafetyRules({...safetyRules,spo2Low:e.target.value})}/>%</label><button className="secondary-button" disabled={safetyBusy || !safetyKey}>Save limits</button></form>
        <div className={`safety-notice ${safety?.whatsappConfigured?'ready':''}`}>{safety?.whatsappConfigured?'Twilio is connected. Device safety alerts will be sent to consented contacts.':'Alerts are detected and saved now, but WhatsApp delivery starts only after Twilio credentials and an approved WhatsApp template are configured on the server.'}</div></>}
      </section>
      <section className="panel reports-panel" id="reports">
        <div className="panel-head"><div><p className="overline">AI INSIGHTS</p><h2>Weekly & monthly reports</h2></div><span className={`report-status ${reportStatus.configured ? 'ready' : ''}`}><i className={`dot ${reportStatus.configured ? 'green' : ''}`}/>{reportStatus.unavailable ? 'Backend not connected' : reportStatus.configured === null ? 'Checking server…' : reportStatus.configured ? 'Gemini ready' : 'Gemini API key needed'}</span></div>
        <p className="report-intro">Get a plain-language summary of recorded trends, missing readings, and device alerts.</p>
        <div className="report-controls"><div className="report-period" role="group" aria-label="Report period"><button type="button" className={reportPeriod === 'week' ? 'active' : ''} onClick={() => { setReportPeriod('week'); setReportResult(null); }}>Weekly <small>7 days</small></button><button type="button" className={reportPeriod === 'month' ? 'active' : ''} onClick={() => { setReportPeriod('month'); setReportResult(null); }}>Monthly <small>30 days</small></button></div><button type="button" className="primary-button report-generate" onClick={generateReport} disabled={reportBusy || reportStatus.configured !== true || !safetyKey}>{reportBusy ? 'Generating…' : 'Generate report'} <span>✦</span></button></div>
        {reportStatus.unavailable && <div className="report-notice error">The Express API server is not responding. Start it with <code>npm run dev:api</code> in a second terminal; the dashboard runs separately on port 5173.</div>}
        {reportStatus.configured === false && !reportStatus.unavailable && <div className="report-notice">The API server is reachable, but it has not loaded <code>GEMINI_API_KEY</code>. Restart the API server from this project folder with <code>npm run dev:api</code>. Keep the key on the server; don’t paste it into this page.</div>}
        {!safetyKey && <div className="report-notice">Reports can be generated from the computer running the dashboard after its private session is ready.</div>}
        {reportError && <div className="report-notice error" role="alert">{reportError}</div>}
        {reportResult && <div className="report-result"><div className="report-result-head"><div><b>{reportResult.period === 'week' ? 'Weekly report' : 'Monthly report'}</b><small>{new Date(reportResult.start).toLocaleDateString()} – {new Date(reportResult.end).toLocaleDateString()} · Generated {new Date(reportResult.generatedAt).toLocaleString()}</small></div><button type="button" className="secondary-button" onClick={downloadReportDoc}>Download Word report</button></div><div className="report-stats"><span><b>{reportResult.metrics.readings}</b><small>readings</small></span><span><b>{reportResult.metrics.daysWithoutReadings}</b><small>days without data</small></span><span><b>{reportResult.metrics.fallFlags}</b><small>fall flags</small></span><span><b>{reportResult.metrics.readingsFlaggedCritical}</b><small>critical flags</small></span></div>{reportResult.reportSource === 'calculated-fallback' && <div className="report-notice">Gemini is unavailable. This report’s summary was calculated directly from the saved readings; it contains no AI interpretation. The daily table and Word download are ready.</div>}<div className="report-copy">{reportResult.report}</div><h3 className="report-daily-title">Daily breakdown</h3><div className="report-daily-wrap"><table className="report-daily-table"><thead><tr><th>Date</th><th>Readings</th><th>HR avg</th><th>HR min</th><th>HR max</th><th>SpO₂ avg</th><th>SpO₂ range</th><th>Falls</th><th>Missing / invalid</th></tr></thead><tbody>{reportResult.daily.map((day) => <tr key={day.date}><td>{day.date}</td><td>{day.readingCount}</td><td>{day.heartRate.averageBpm ?? '—'}{day.heartRate.averageBpm !== null && ' bpm'}</td><td>{day.heartRate.minBpm ?? '—'}{day.heartRate.minBpm !== null && ' bpm'}</td><td>{day.heartRate.maxBpm ?? '—'}{day.heartRate.maxBpm !== null && ' bpm'}</td><td>{day.spo2.averagePercent ?? '—'}{day.spo2.averagePercent !== null && '%'}</td><td>{day.spo2.minPercent ?? '—'}–{day.spo2.maxPercent ?? '—'}{day.spo2.validSamples > 0 && '%'}</td><td>{day.fallFlags}</td><td>HR {day.heartRate.missingOrInvalid}; SpO₂ {day.spo2.missingOrInvalid}{day.readingCount === 0 && ' · No readings'}</td></tr>)}</tbody></table></div><p className="report-disclaimer">{reportResult.reportSource === 'calculated-fallback' ? 'This calculated summary is informational only and is not a diagnosis or medical advice.' : 'This AI-generated summary is informational only, not a diagnosis or medical advice.'} Wearable readings may be inaccurate. Fall counts are device flags, not verified events.</p></div>}
        <p className="report-privacy">When you request a report, only date-wise reading aggregates are sent to Google Gemini. Names, contact details, device IDs, and raw payloads are excluded.</p>
      </section>

      <section className="metrics">
        <article className="metric heart-metric"><div className="metric-head"><span className="metric-symbol pink"><Icon name="heart"/></span><span className={`live-label ${isDemo?'demo-label':''}`}><i className={`dot ${online ? 'green blink' : ''}`}/>{isDemo?'SAMPLE':online?'LIVE':'OFFLINE'}</span></div><p>Heart rate</p><strong>{heartRate ?? '—'}<small>bpm</small></strong><div className="metric-foot"><span>{avg === null ? 'No readings yet' : `${isDemo?'Sample':'Avg.'} ${avg} bpm`}</span><span>{ago(latest?.receivedAt, now)}</span></div><div className="mini"><Sparkline values={trend}/></div></article>
        <article className="metric"><div className="metric-head"><span className="metric-symbol blue"><Icon name="drop"/></span><span className="soft-tag">BLOOD OXYGEN</span></div><p>Oxygen saturation</p><strong>{spo2 ?? '—'}<small>%</small></strong><div className="metric-foot"><span>{spo2 === null ? 'Waiting for a reading' : spo2 >= 95 ? 'Within usual range' : 'Below usual range'}</span><span className="progress"><i style={{width:`${Math.min(Math.max(spo2 || 0,0),100)}%`}}/></span></div></article>
        <article className="metric"><div className="metric-head"><span className="metric-symbol violet"><Icon name="pulse"/></span><span className="soft-tag">STORED LOCALLY</span></div><p>Total readings</p><strong>{totalReadings}<small>events</small></strong><div className="metric-foot"><span>Saved in MongoDB</span><span className="saved"><Icon name="check" size={14}/></span></div></article>
      </section>

      <section className="panel fall-ai-panel" id="fall-model">
        <div className="panel-head"><div><p className="overline">EXPERIMENTAL ML</p><h2>Early fall prediction</h2></div><span className="model-tag"><i className={`dot ${motionAnalyzed ? 'green' : ''}`}/>{motionFeed?.model?.status === 'experimental' ? 'WEDA-FALL · unverified' : 'Model status'}</span></div>
        <div className={`motion-result ${motionAnalyzed && motionResult.label === 'fall_predicted' ? 'motion-alert' : ''}`}>
          <span className="motion-result-icon"><Icon name={motionAnalyzed && motionResult.label === 'fall_predicted' ? 'bell' : 'pulse'} size={20}/></span>
          <span className="motion-result-copy"><b>{!latestMotionFresh ? (motionFeedError ? 'Motion analysis unavailable' : 'Waiting for live motion data') : motionAnalyzed ? (motionResult.label === 'fall_predicted' ? 'Fall predicted soon' : 'No fall predicted') : motionResult?.state === 'warming_up' ? 'Building a motion window…' : motionResult?.state === 'unsupported_sample_rate' ? 'Sampling rate not supported' : motionResult?.state === 'sampling_gap' ? 'Motion stream gap' : motionResult?.state === 'model_unavailable' ? 'Model unavailable' : 'Waiting for analysis'}</b>
            <small>{motionAnalyzed ? `Experimental estimate for ${motionResult.predictionLeadSeconds?.minimum}–${motionResult.predictionLeadSeconds?.maximum}s ahead · score ${(motionResult.score * 100).toFixed(0)} · ${ago(latestMotion.receivedAt, now)}` : latestMotionFresh ? (motionResult?.message || 'Waiting for enough sensor samples.') : 'Upload MPU6050 batches to /api/motion; the model needs a full 1.5-second window.'}</small></span>
          {motionAnalyzed && <span className={`motion-score ${motionResult.label === 'fall_predicted' ? 'warn' : ''}`}>{(motionResult.score * 100).toFixed(0)}<small>score</small></span>}
        </div>
        <div className="motion-context"><span><small>HEART RATE · CONTEXT ONLY</small><b>{contextHeartRate ?? '—'}{contextHeartRate !== null && ' bpm'}</b></span><span><small>SpO₂ · CONTEXT ONLY</small><b>{contextSpo2 ?? '—'}{contextSpo2 !== null && '%'}</b></span><span><small>LAST MOTION BATCH</small><b>{latestMotion ? ago(latestMotion.receivedAt, now) : 'No batches yet'}</b></span></div>
        {motionFeedError && <p className="motion-notice error">{motionFeedError}. Open the dashboard locally at localhost:3000 to access private motion results.</p>}
        <p className="motion-notice">This experimental model estimates whether the next acceleration peak may occur within a short lead window. It derives impact proxies from the highest 50 Hz acceleration magnitude inside WEDA-FALL’s manually timed fall intervals; those peaks have not been checked against video and may not be the true ground impact. On held-out participants it achieved {motionHoldout ? `${Math.round(motionHoldout.fallEventRecall * 100)}% fall-event recall with false signals in ${Math.round(motionHoldout.activityTrialFalseAlarmRate * 100)}% of ordinary-activity trials` : 'no held-out evaluation yet'}, so it is not reliable enough for safety alerts. The score is not a calibrated probability. Heart rate and SpO₂ are shown for context only; they are not model inputs. No model result sends WhatsApp alerts.</p>
      </section>

      <section className="mid-grid">
        <article className="panel trend-panel"><div className="panel-head"><div><p className="overline">YOUR VITALS</p><h2>Heart rate trend</h2></div><div className="period">{['Today','Week','Month'].map((v)=><button key={v} onClick={()=>setPeriod(v)} className={period===v?'active':''}>{v}</button>)}</div></div><div className="trend-summary"><b>{avg ?? '—'}<small> bpm</small></b><span><Icon name="arrow" size={14}/> {isDemo?'sample average':'live average'}</span></div><div className="chart">{trend.length ? <Sparkline values={trend} large/> : <div className="chart-empty"><span><Icon name="pulse" size={22}/></span>Chart will fill in as your device sends readings</div>}</div><div className="axis"><span>Oldest</span><span>Recent readings</span><span>Now</span></div></article>
        <article className="panel device-panel" id="device"><div className="panel-head"><div><p className="overline">CONNECTED DEVICE</p><h2>Device status</h2></div><div className="menu-anchor"><button className="more" aria-label="Device actions" aria-expanded={deviceMenu} onClick={()=>setDeviceMenu(!deviceMenu)}>···</button>{deviceMenu&&<div className="action-menu"><button onClick={()=>{refreshData();setDeviceMenu(false);notify('Readings refreshed')}}><Icon name="pulse" size={15}/>Refresh readings</button><button onClick={()=>{setDeviceMenu(false);copyEndpoint()}}><span className="menu-symbol">↗</span>Copy device endpoint</button><button onClick={exportCsv}><span className="menu-symbol">↓</span>Export recent readings</button></div>}</div></div><div className="device-scene"><div className="glow"/><div className="orbit orbit-a"/><div className="orbit orbit-b"/><div className="watch"><div className="watch-strap top-strap"/><div className="watch-strap bottom-strap"/><div className="watch-screen"><b>{heartRate ?? '––'}</b><small>BPM</small><span><Icon name="pulse" size={29}/></span></div></div></div><div className="device-name"><span><b>{device}</b><small>Health band · Wearable</small></span><span className={`state ${online?'on':''}`}><i className={`dot ${online?'green':''}`}/>{online?'Online':'Offline'}</span></div><div className="device-meta"><span>Last synced <b>{ago(latest?.receivedAt,now)}</b></span><span>Database <b className={dbState==='connected'?'green-text':''}>{dbState==='connected'?'Connected':'Unavailable'}</b></span></div><a className="device-explore-link" href="/device" target="_blank" rel="noopener noreferrer">Explore interactive 3D view <span>↗</span></a></article>
      </section>

      <section className="panel table-panel" id="readings"><div className="panel-head table-heading"><div><p className="overline">LATEST ACTIVITY</p><h2>Recent readings</h2></div><span className="refresh-note"><i className="dot green"/>Auto-refreshes every few seconds</span></div><div className="table-wrap"><table><thead><tr><th>DEVICE</th><th>HEART RATE</th><th>SPO₂</th><th>FALL ALERT</th><th>RECEIVED</th><th>STATUS</th></tr></thead><tbody>{events.slice(0,6).map((event)=><tr key={event.id}><td><span className="device-cell"><i><Icon name="watch" size={15}/></i><b>{event.data?.deviceId || event.deviceId || 'Unknown device'}</b></span></td><td><b>{val(event.data?.heartRate ?? event.data?.heartbeat) ?? '—'}</b><small> bpm</small></td><td><b>{val(event.data?.spo2 ?? event.data?.SpO2) ?? '—'}</b><small>%</small></td><td><span className={`fall ${Boolean(event.data?.fallAlert ?? event.data?.fall_alert)?'warn':''}`}><i/> {Boolean(event.data?.fallAlert ?? event.data?.fall_alert)?'Detected':'None'}</span></td><td>{fmtTime(event.receivedAt)}</td><td><span className="status-pill"><Icon name="check" size={12}/>{Boolean(event.data?.fallAlert ?? event.data?.fall_alert)?'Attention':event.data?.status || 'Received'}</span></td></tr>)}{!events.length&&<tr><td colSpan="6"><div className="empty-state"><span><Icon name="pulse" size={20}/></span><b>Waiting for your first reading</b><small>Incoming device data will show up here automatically.</small></div></td></tr>}</tbody></table></div><div className="table-bottom"><span>Showing {Math.min(events.length,6)} of {totalReadings} readings</span><span><i className={`dot ${dbState==='connected'?'green':''}`}/>Data stays on this computer</span></div></section>
      <footer className="footer"><span>Pulse device dashboard</span><span>Private by design <b>♥</b></span></footer>
    </main>
    {toast&&<div className="toast" role="status">{toast}</div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
