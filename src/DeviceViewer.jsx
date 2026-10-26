import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const colors = { band: 0x353343, case: 0xb8b6c8, screen: 0x171724, crown: 0x9c98ab, sensors: 0x8e8b9c };

function roundedShape(width, height, radius) {
  const shape = new THREE.Shape();
  const x = -width / 2, y = -height / 2;
  shape.moveTo(x + radius, y); shape.lineTo(x + width - radius, y); shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius); shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height); shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius); shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

function extrudedRounded(width, height, radius, depth, bevel = 0.035) {
  return new THREE.ExtrudeGeometry(roundedShape(width, height, radius), { depth, bevelEnabled: bevel > 0, bevelSegments: 3, steps: 1, bevelSize: bevel, bevelThickness: bevel, curveSegments: 8 });
}

function mappedScreenGeometry(width, height, radius) {
  const geometry = new THREE.ShapeGeometry(roundedShape(width, height, radius), 20);
  const positions = geometry.getAttribute('position'), uvs = new Float32Array(positions.count * 2);
  for (let i = 0; i < positions.count; i++) {
    uvs[i * 2] = (positions.getX(i) + width / 2) / width;
    uvs[i * 2 + 1] = (positions.getY(i) + height / 2) / height;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geometry;
}

function addPart(parent, key, geometry, material, position, rotation) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position); if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.part = key; parent.add(mesh); return mesh;
}

function makeScreenTexture(heartRate, spo2, time, page = 'time') {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 680;
  const ctx = canvas.getContext('2d');
  const theme = { colors: ['#28213f','#0c1018'], accent: '#b7a6ff' };
  const gradient = ctx.createLinearGradient(0, 0, 512, 680); gradient.addColorStop(0, theme.colors[0]); gradient.addColorStop(1, theme.colors[1]);
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 680);
  const accent = theme.accent;
  const glow = ctx.createRadialGradient(256, 190, 12, 256, 190, 320); glow.addColorStop(0, `${accent}36`); glow.addColorStop(1, `${accent}00`); ctx.fillStyle = glow; ctx.fillRect(0, 0, 512, 680);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 31px Arial'; ctx.fillText('PULSE', 40, 60);
  ctx.fillStyle = '#aeb6c8'; ctx.font = '19px Arial'; ctx.fillText(page === 'heart' ? 'HEART RATE' : page === 'spo2' ? 'BLOOD OXYGEN' : 'SMART BAND', 40, 91);
  ctx.fillStyle = '#74e0b7'; ctx.beginPath(); ctx.arc(442, 52, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#d7e2e7'; ctx.font = '19px Arial'; ctx.textAlign = 'right'; ctx.fillText('LIVE', 475, 59); ctx.textAlign = 'left';
  if (page === 'heart') {
    ctx.textAlign = 'center'; ctx.fillStyle = '#ff91ab'; ctx.font = '56px Arial'; ctx.fillText('♥', 256, 183);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 120px Arial'; ctx.fillText(String(heartRate ?? '--'), 256, 329);
    ctx.fillStyle = '#c2c4d1'; ctx.font = '30px Arial'; ctx.fillText('beats per minute', 256, 374);
    ctx.strokeStyle = '#ff91ab'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(45, 495); ctx.lineTo(112, 495); ctx.lineTo(150, 447); ctx.lineTo(190, 551); ctx.lineTo(232, 473); ctx.lineTo(275, 495); ctx.lineTo(344, 495); ctx.lineTo(382, 456); ctx.lineTo(421, 535); ctx.lineTo(465, 495); ctx.stroke();
    ctx.fillStyle = '#aeb6c8'; ctx.font = '22px Arial'; ctx.fillText('Current heart rate', 256, 600);
  } else if (page === 'spo2') {
    ctx.textAlign = 'center'; ctx.strokeStyle = `${accent}55`; ctx.lineWidth = 16; ctx.beginPath(); ctx.arc(256, 320, 138, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = accent; ctx.lineWidth = 16; ctx.beginPath(); ctx.arc(256, 320, 138, -Math.PI/2, -Math.PI/2 + Math.PI * 2 * Math.min(100, Number(spo2) || 0) / 100); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 105px Arial'; ctx.fillText(String(spo2 ?? '--'), 256, 333);
    ctx.fillStyle = '#c2c4d1'; ctx.font = '29px Arial'; ctx.fillText('SpO₂  ·  %', 256, 388);
    ctx.fillStyle = accent; ctx.font = '23px Arial'; ctx.fillText('OXYGEN SATURATION', 256, 550);
  } else {
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = 'bold 96px Arial'; ctx.fillText(time, 256, 240);
    ctx.fillStyle = '#c2c4d1'; ctx.font = '26px Arial'; ctx.fillText(new Date().toLocaleDateString([], {weekday:'long',month:'short',day:'numeric'}), 256, 289);
    ctx.fillStyle = '#ff91ab'; ctx.font = 'bold 49px Arial'; ctx.fillText('♥', 126, 433);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 48px Arial'; ctx.textAlign = 'left'; ctx.fillText(String(heartRate ?? '--'), 172, 433);
    ctx.fillStyle = '#aeb6c8'; ctx.font = '20px Arial'; ctx.fillText('BPM', 258, 432);
    ctx.fillStyle = accent; ctx.font = '43px Arial'; ctx.textAlign = 'left'; ctx.fillText('◉', 306, 433);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 45px Arial'; ctx.fillText(String(spo2 ?? '--'), 350, 433);
    ctx.fillStyle = '#aeb6c8'; ctx.font = '19px Arial'; ctx.textAlign = 'center'; ctx.fillText('Swipe for your live health readings', 256, 546);
  }
  const pages = ['time','heart','spo2']; ctx.textAlign = 'center'; pages.forEach((item,index) => { ctx.fillStyle = page === item ? accent : '#ffffff60'; ctx.beginPath(); ctx.arc(228 + index * 28, 635, page === item ? 7 : 5, 0, Math.PI*2); ctx.fill(); });
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8; return texture;
}

function buildModel(scene, valuesRef, activeRef, explodedRef) {
  const model = new THREE.Group(); model.rotation.x = -0.06; scene.add(model);
  const parts = {};
  const group = (key) => { const g = new THREE.Group(); g.userData.part = key; model.add(g); parts[key] = g; return g; };
  const band = group('band'), caseGroup = group('case'), screenGroup = group('screen'), crown = group('crown'), sensors = group('sensors');
  const partOutlines = Object.fromEntries(Object.keys(parts).map((key) => {
    const outline = new THREE.Box3Helper(new THREE.Box3(), 0x8574ff); outline.visible = false; scene.add(outline); return [key, outline];
  }));
  const mats = {
    band: new THREE.MeshStandardMaterial({ color: colors.band, roughness: 0.34, metalness: 0.12 }),
    case: new THREE.MeshStandardMaterial({ color: colors.case, roughness: 0.24, metalness: 0.82 }),
    edge: new THREE.MeshStandardMaterial({ color: 0x6b687a, roughness: 0.2, metalness: 0.9 }),
    screen: new THREE.MeshStandardMaterial({ color: 0xffffff, map: makeScreenTexture(valuesRef.current.heartRate, valuesRef.current.spo2, valuesRef.current.time, valuesRef.current.page), roughness: 0.12, metalness: 0.04, emissive: 0x24213a, emissiveIntensity: 0.28 }),
    black: new THREE.MeshStandardMaterial({ color: 0x12131b, roughness: 0.17, metalness: 0.12 }),
    sensor: new THREE.MeshStandardMaterial({ color: 0x85d9bf, roughness: 0.22, metalness: 0.5, emissive: 0x235f51, emissiveIntensity: 0.28 }),
    screw: new THREE.MeshStandardMaterial({ color: 0xddd9e5, roughness: 0.2, metalness: 0.9 }),
  };
  // Two textured strap halves with rows of sizing holes and visible metal connectors.
  for (const sign of [-1, 1]) {
    const y = sign * 1.56;
    addPart(band, 'band', extrudedRounded(0.83, 1.95, 0.31, 0.16, 0.07), mats.band, [0, y, -0.04]);
    for (let i = 0; i < 7; i++) {
      const holeY = sign * (0.98 + i * 0.22);
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.049, 0.049, 0.012, 24), mats.black);
      hole.rotation.x = Math.PI / 2; hole.position.set(0, holeY, 0.13); hole.userData.part = 'band'; band.add(hole);
    }
    addPart(caseGroup, 'case', new THREE.BoxGeometry(0.8, 0.12, 0.18), mats.edge, [0, sign * 0.88, 0.01]);
  }
  // Rounded metal case and front bezel.
  addPart(caseGroup, 'case', extrudedRounded(1.62, 1.91, 0.39, 0.34, 0.065), mats.case, [0, 0, -0.17]);
  addPart(caseGroup, 'case', extrudedRounded(1.39, 1.68, 0.3, 0.055, 0.025), mats.edge, [0, 0, 0.17]);
  // Four narrow bezel rails frame the glass; the live canvas is the glass surface itself.
  addPart(screenGroup, 'screen', new THREE.BoxGeometry(1.27, 0.064, 0.046), mats.black, [0, 0.747, 0.251]);
  addPart(screenGroup, 'screen', new THREE.BoxGeometry(1.27, 0.064, 0.046), mats.black, [0, -0.747, 0.251]);
  addPart(screenGroup, 'screen', new THREE.BoxGeometry(0.064, 1.43, 0.046), mats.black, [-0.603, 0, 0.251]);
  addPart(screenGroup, 'screen', new THREE.BoxGeometry(0.064, 1.43, 0.046), mats.black, [0.603, 0, 0.251]);
  addPart(screenGroup, 'screen', mappedScreenGeometry(1.16, 1.43, 0.19), mats.screen, [0, 0, 0.276]);
  // Small case screws add separation and detail to the bezel.
  for (const x of [-0.59, 0.59]) for (const y of [-0.74, 0.74]) {
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.012, 16), mats.screw);
    screw.rotation.x = Math.PI / 2; screw.position.set(x, y, 0.245); screw.userData.part = 'case'; caseGroup.add(screw);
  }
  // Rotating side crown and a separate function button.
  const crownMesh = addPart(crown, 'crown', new THREE.CylinderGeometry(0.115, 0.115, 0.22, 32), mats.case, [0.88, 0.34, 0.02], [0, 0, Math.PI / 2]);
  crownMesh.material = mats.case;
  addPart(crown, 'crown', new THREE.CylinderGeometry(0.072, 0.072, 0.12, 24), mats.edge, [0.9, -0.22, 0.03], [0, 0, Math.PI / 2]);
  // Reverse case plate with optical sensor lenses and charging contacts.
  addPart(sensors, 'sensors', extrudedRounded(1.31, 1.59, 0.28, 0.035, 0.015), mats.edge, [0, 0, -0.218]);
  const sensorLens = new THREE.MeshStandardMaterial({ color: 0x18251f, roughness: 0.13, metalness: 0.28 });
  for (const [x, y, radius] of [[0,0,0.28],[-0.29,0.2,0.105],[0.29,0.2,0.105],[-0.29,-0.2,0.105],[0.29,-0.2,0.105]]) {
    addPart(sensors, 'sensors', new THREE.CylinderGeometry(radius, radius, 0.045, 36), sensorLens, [x, y, -0.28], [Math.PI/2, 0, 0]);
    if (radius < 0.2) addPart(sensors, 'sensors', new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, 0.05, 28), mats.sensor, [x, y, -0.31], [Math.PI/2,0,0]);
  }
  for (const x of [-0.42, 0.42]) addPart(sensors, 'sensors', new THREE.CylinderGeometry(0.055, 0.055, 0.035, 28), mats.screw, [x, -0.57, -0.28], [Math.PI/2,0,0]);

  model.traverse((node) => { if (node.isMesh) node.userData.materials = Array.isArray(node.material) ? node.material : [node.material]; });
  const renderState = () => {
    const active = activeRef.current, exploded = explodedRef.current;
    for (const [key, part] of Object.entries(parts)) {
      part.visible = true;
      partOutlines[key].visible = Boolean(active === key);
      if (active === key) { partOutlines[key].box.setFromObject(part); partOutlines[key].updateMatrixWorld(true); }
    }
    parts.band.position.x = exploded ? -1.12 : 0;
    parts.case.position.set(0, 0, exploded ? 0 : 0);
    parts.screen.position.set(0, 0, exploded ? 0.52 : 0);
    parts.crown.position.set(exploded ? 0.48 : 0, 0, 0);
    parts.sensors.position.set(0, 0, exploded ? -0.55 : 0);
  };
  renderState();
  return { model, parts, renderState, dispose: () => { model.traverse((node) => { if (node.isMesh) node.geometry.dispose(); }); Object.values(partOutlines).forEach((outline) => { scene.remove(outline); outline.geometry.dispose(); outline.material.dispose(); }); Object.values(mats).forEach((material) => { material.map?.dispose(); material.dispose(); }); sensorLens.dispose(); } };
}

export default function DeviceViewer({ heartRate, spo2, time, theme = 'light' }) {
  const [page, setPage] = useState('time');
  const hostRef = useRef(null), threeRef = useRef(null), uiRef = useRef(null), valuesRef = useRef({ heartRate, spo2, time, page, theme });
  const activeRef = useRef(null), explodedRef = useRef(false), [activePart, setActivePart] = useState(null), [exploded, setExploded] = useState(false), [error, setError] = useState('');
  valuesRef.current = { heartRate, spo2, time, page, theme };
  uiRef.current = { page, setPage };
  useEffect(() => {
    const host = hostRef.current; if (!host) return undefined;
    let renderer, model, observer, animationId, controls, ground, watchGesture = null, downOnScreen, upOnScreen; const scene = new THREE.Scene(); scene.background = new THREE.Color(valuesRef.current.theme === 'dark' ? '#171824' : '#f4f5f8');
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100); camera.position.set(4.6, 3.2, 6.8);
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.domElement.setAttribute('aria-label', 'Rotatable 3D health band model'); host.appendChild(renderer.domElement);
      scene.add(new THREE.HemisphereLight(0xf6f4ff, 0x858198, 2.2));
      const key = new THREE.DirectionalLight(0xffffff, 3.3); key.position.set(3, 5, 5); key.castShadow = true; scene.add(key);
      const rim = new THREE.DirectionalLight(0xa79bff, 2.2); rim.position.set(-4, 1, -3); scene.add(rim);
      ground = new THREE.Mesh(new THREE.CircleGeometry(3.1, 72), new THREE.MeshStandardMaterial({ color: valuesRef.current.theme === 'dark' ? '#292a38' : '#eeedf5', roughness: 0.88 })); ground.rotation.x = -Math.PI / 2; ground.position.y = -2.9; ground.receiveShadow = true; scene.add(ground);
      model = buildModel(scene, valuesRef, activeRef, explodedRef);
      controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = 0.07; controls.enablePan = false; controls.minDistance = 4; controls.maxDistance = 12; controls.rotateSpeed = 0.8; controls.target.set(0, 0, 0); controls.update();
      const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
      downOnScreen = (event) => {
        const bounds = renderer.domElement.getBoundingClientRect(); pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1; pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(model.parts.screen.children, true).length > 0;
        if (hit) { watchGesture = { x: event.clientX, y: event.clientY }; controls.enabled = false; }
      };
      upOnScreen = (event) => {
        if (!watchGesture) return;
        const dx = event.clientX - watchGesture.x, dy = event.clientY - watchGesture.y; watchGesture = null; controls.enabled = true;
        const pages = ['time','heart','spo2'];
        if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy)) uiRef.current?.setPage((current) => pages[(pages.indexOf(current) + (dx < 0 ? 1 : pages.length - 1)) % pages.length]);
        else if (Math.abs(dy) > 30 && Math.abs(dy) > Math.abs(dx)) uiRef.current?.setPage(dy > 0 ? 'heart' : 'time');
      };
      renderer.domElement.addEventListener('pointerdown', downOnScreen);
      renderer.domElement.addEventListener('pointerup', upOnScreen);
      renderer.domElement.addEventListener('pointercancel', upOnScreen);
      const resize = () => { const width = host.clientWidth || 640, height = host.clientHeight || 500; camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); };
      observer = new ResizeObserver(resize); observer.observe(host); resize();
      const render = () => { animationId = requestAnimationFrame(render); controls.update(); renderer.render(scene, camera); }; render();
      threeRef.current = { model, controls, renderer, scene, ground, downOnScreen, upOnScreen };
    } catch (cause) { setError(cause.message || 'This browser could not start the 3D view.'); }
    return () => { cancelAnimationFrame(animationId); observer?.disconnect(); if (renderer) { renderer.domElement.removeEventListener('pointerdown', downOnScreen); renderer.domElement.removeEventListener('pointerup', upOnScreen); renderer.domElement.removeEventListener('pointercancel', upOnScreen); } controls?.dispose(); model?.dispose(); renderer?.dispose(); renderer?.domElement.remove(); threeRef.current = null; };
  }, []);
  useEffect(() => {
    const state = threeRef.current; if (!state) return;
    state.scene.background.set(theme === 'dark' ? '#171824' : '#f4f5f8');
    state.ground.material.color.set(theme === 'dark' ? '#292a38' : '#eeedf5');
  }, [theme]);
  useEffect(() => {
    const state = threeRef.current; if (!state) return;
    const material = state.model.parts.screen.children.flatMap((child) => child.isMesh ? child.userData.materials : []).find((item) => item?.map);
    if (!material) return;
    const next = makeScreenTexture(heartRate, spo2, time, page); material.map?.dispose(); material.map = next; material.needsUpdate = true;
  }, [heartRate, spo2, time, page]);
  const choosePart = (key) => { activeRef.current = key; setActivePart(key); threeRef.current?.model.renderState(); };
  const toggleExploded = () => { const next = !exploded; explodedRef.current = next; setExploded(next); threeRef.current?.model.renderState(); };
  const parts = [['band','Band'],['case','Case'],['screen','Display'],['crown','Side controls'],['sensors','Rear sensors']];
  const partDescriptions = { band: 'Flexible strap and sizing holes.', case: 'Metal housing and raised bezel.', screen: 'Live watch face with the latest heart rate and SpO₂.', crown: 'Rotating crown and side button.', sensors: 'Optical sensors and charging contacts on the back.' };
  const watchPages = [['time','Time'],['heart','Heart rate'],['spo2','SpO₂']];
  return <div className="true-viewer">
    <div className="viewer-toolbar"><div className="part-picker"><button className={!activePart?'selected':''} onClick={()=>choosePart(null)}>Whole device</button>{parts.map(([key,label])=><button key={key} className={activePart===key?'selected':''} onClick={()=>choosePart(key)}>{label}</button>)}</div><button className={`exploded-toggle ${exploded?'selected':''}`} onClick={toggleExploded}>{exploded?'Assembled view':'Exploded view'}<span>✣</span></button></div>
    <div className="part-inspector" aria-live="polite"><span className="inspector-mark">{activePart?'◎':'⌚'}</span><span><b>{activePart ? parts.find(([key])=>key===activePart)?.[1] : 'Complete health band'}</b><small>{activePart ? partDescriptions[activePart] : 'Select a part to highlight it. The rest of the device stays assembled.'}</small></span></div>
    <div className="true-viewer-stage" ref={hostRef}>{error&&<div className="viewer-error">3D view unavailable: {error}</div>}</div>
    <div className="watch-page-picker"><span>WATCH FACE</span>{watchPages.map(([key,label])=><button key={key} className={page===key?'active':''} onClick={()=>setPage(key)}>{label}</button>)}</div>
    <div className="viewer-instructions"><span><i>↻</i> Drag the watch to rotate it</span><span><i>⌕</i> Scroll over the model to zoom</span><span><i>↔</i> Swipe on its screen to change pages</span></div>
  </div>;
}
