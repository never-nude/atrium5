const AXES = new Set(['auto', 'x', 'y', 'z']);

function finiteNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function rotationArray(value) {
  if (!Array.isArray(value) || value.length !== 3) return [0, 0, 0];
  return value.map((item) => finiteNumber(item, 0));
}

function parseLegacyTransform(value) {
  const [rawAxis, rawFit, rawYaw] = String(value || 'auto').toLowerCase().split(':');
  const upAxis = AXES.has(rawAxis) ? rawAxis : 'auto';
  const fit = finiteNumber(rawFit, 0);
  return {
    upAxis,
    fit: fit > 0 ? fit : 0,
    yaw: finiteNumber(rawYaw, 0),
    modelRotation: [0, 0, 0],
  };
}

export function parseModelTransform(value, fallback = 'auto') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        return parseModelTransform(JSON.parse(trimmed), fallback);
      } catch {
        return parseLegacyTransform(fallback);
      }
    }
    return parseLegacyTransform(trimmed || fallback);
  }

  if (!value || typeof value !== 'object') return parseLegacyTransform(fallback);

  const legacy = parseLegacyTransform(value.upAxis || value.axis || fallback);
  const upAxis = AXES.has(String(value.upAxis || value.axis || legacy.upAxis).toLowerCase())
    ? String(value.upAxis || value.axis || legacy.upAxis).toLowerCase()
    : legacy.upAxis;
  const fit = finiteNumber(value.fit, legacy.fit);
  const yaw = finiteNumber(value.yaw, legacy.yaw);

  return {
    ...value,
    upAxis,
    fit: fit > 0 ? fit : 0,
    yaw,
    modelRotation: rotationArray(value.modelRotation || value.rotation),
  };
}

export function applyModelTransform(THREE, model, rawTransform = 'auto') {
  const transform = parseModelTransform(rawTransform);
  let box = new THREE.Box3().setFromObject(model);
  let size = box.getSize(new THREE.Vector3());
  const isLikelyZUp = size.z > size.y * 1.15 && size.z > Math.min(size.x, size.y) * 1.15;

  if (transform.upAxis === 'z' || (transform.upAxis === 'auto' && isLikelyZUp)) {
    model.rotation.x -= Math.PI / 2;
  } else if (transform.upAxis === 'x') {
    model.rotation.z += Math.PI / 2;
  }

  const [rx, ry, rz] = transform.modelRotation;
  if (rx) model.rotation.x += THREE.MathUtils.degToRad(rx);
  if (ry) model.rotation.y += THREE.MathUtils.degToRad(ry);
  if (rz) model.rotation.z += THREE.MathUtils.degToRad(rz);
  if (transform.yaw) model.rotation.y += THREE.MathUtils.degToRad(transform.yaw);

  box = new THREE.Box3().setFromObject(model);
  size = box.getSize(new THREE.Vector3());
  return { box, size, transform };
}

export function normalizeModel(THREE, model) {
  let box = new THREE.Box3().setFromObject(model);
  let size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  model.scale.setScalar(1 / maxDim);
  box = new THREE.Box3().setFromObject(model);
  size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  box = new THREE.Box3().setFromObject(model);
  size = box.getSize(new THREE.Vector3());
  return { box, size, center, scale: 1 / maxDim };
}

function cornersForBox(THREE, box) {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

export function frameCameraToBox(THREE, camera, box, options = {}) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.01);
  const direction = new THREE.Vector3(...(options.direction || [0.55, 0.34, 0.9])).normalize();
  const target = center.clone();
  target.y += size.y * finiteNumber(options.verticalBias, 0);
  const padding = Math.max(1.01, finiteNumber(options.padding, 1.18));
  const limit = 1 / padding;
  const corners = cornersForBox(THREE, box);

  function place(distance) {
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  }

  function fits(distance) {
    place(distance);
    let maxX = 0;
    let maxY = 0;
    for (const corner of corners) {
      const projected = corner.clone().project(camera);
      maxX = Math.max(maxX, Math.abs(projected.x));
      maxY = Math.max(maxY, Math.abs(projected.y));
    }
    return maxX <= limit && maxY <= limit;
  }

  let high = Math.max(radius * 2, 0.5);
  while (!fits(high) && high < 1000) high *= 1.5;
  let low = 0.01;
  for (let i = 0; i < 44; i += 1) {
    const mid = (low + high) / 2;
    if (fits(mid)) high = mid;
    else low = mid;
  }

  place(high);
  camera.near = Math.max(0.005, high - radius * 4);
  camera.far = Math.max(camera.near + 10, high + radius * 4);
  camera.updateProjectionMatrix();
  return { distance: high, target, padding };
}
