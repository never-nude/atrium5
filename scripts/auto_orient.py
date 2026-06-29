#!/usr/bin/env python3
"""auto_orient.py — propose an orientations.json entry for a new piece.

Given a source mesh, propose an upright/flat orientation in atrium5's
`orientations.json` convention (upAxis + modelRotation degrees, Euler XYZ),
together with a CONFIDENCE score and a needs-review FLAG. The viewer applies
the transform via public/model-render-utils.js: an optional axis remap, then
modelRotation [rx,ry,rz], then yaw — so we emit modelRotation with upAxis:"y"
(no auto remap) for full control.

Philosophy: auto-solve the easy majority; FLAG the cases that needed human
judgment on this project (heads/busts, reliefs, reclining/pediment figures,
ambiguous multi-pose objects). Never silently guess those.

Usage:
    python3 scripts/auto_orient.py <mesh_path> [--slug greek/foo]
Emits one JSON object on stdout:
    {slug, upAxis, modelRotation, yaw, confidence, flag, reason, integrity}

Deps: trimesh, numpy, scipy, networkx (fast_simplification not required here).
Note: pass an UNCOMPRESSED source mesh (STL/OBJ/plain GLB). For Draco/meshopt
GLBs, decode first (e.g. `gltf-transform cp in.glb out.glb`).
"""
import sys, json, math, argparse
import numpy as np
import trimesh


# ---------- geometry helpers ----------
def euler_xyz_from_matrix(R):
    """Decompose a rotation matrix to THREE 'XYZ' Euler degrees."""
    sy = max(-1.0, min(1.0, R[0, 2]))
    ry = math.asin(sy)
    if abs(sy) < 0.99999:
        rx = math.atan2(-R[1, 2], R[2, 2])
        rz = math.atan2(-R[0, 1], R[0, 0])
    else:
        rx = math.atan2(R[2, 1], R[1, 1]); rz = 0.0
    return [round(math.degrees(a), 2) for a in (rx, ry, rz)]


def Rx(deg):
    r = math.radians(deg); c, s = math.cos(r), math.sin(r)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def load_mesh(path):
    m = trimesh.load(path, force="mesh", process=False)
    if isinstance(m, trimesh.Scene):
        m = trimesh.util.concatenate(
            [g for g in m.geometry.values()
             if isinstance(g, trimesh.Trimesh) and len(g.faces)])
    return m


# ---------- integrity (quality gate) ----------
def integrity(m):
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    mm = m.copy(); mm.merge_vertices(); mm.remove_unreferenced_vertices()
    mm.update_faces(mm.nondegenerate_faces())
    F = np.asarray(mm.faces); V = np.asarray(mm.vertices)
    if len(F) == 0:
        return dict(faces=0, bratio=1.0, ncomp=0, largest_frac=0.0)
    e = np.sort(F[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
    uniq, counts = np.unique(e, axis=0, return_counts=True)
    bratio = float((counts == 1).sum()) / max(len(uniq), 1)
    g = coo_matrix((np.ones(len(uniq)), (uniq[:, 0], uniq[:, 1])), shape=(len(V), len(V)))
    _, lab = connected_components(g, directed=False)
    _, c = np.unique(lab[np.unique(F)], return_counts=True)
    return dict(faces=int(len(F)), bratio=round(bratio, 3), ncomp=int(len(c)),
                largest_frac=round(float(c.max()) / c.sum(), 3))


# ---------- orientation proposal ----------
def propose(m):
    V = np.asarray(m.vertices, float)
    ext = np.sort(V.max(0) - V.min(0))          # ascending: thin, mid, long
    thin, mid, lng = ext
    aspect_long = lng / max(mid, 1e-9)
    aspect_flat = mid / max(thin, 1e-9)

    # --- shape-class flag: flat/slab (likely relief, reclining, pediment) ---
    if thin / max(lng, 1e-9) < 0.18 and aspect_flat > 3.0:
        return _entry("auto", [0, 0, 0], 0.2, "review",
                      "Flat/slab shape (likely relief, reclining, or pediment figure) "
                      "- orientation may be intentional; needs human review.")

    # --- elongated => PCA long axis to vertical (poles, standing figures) ---
    if aspect_long > 2.2:
        C = V - V.mean(0)
        w, vecs = np.linalg.eigh(C.T @ C)
        axis = vecs[:, int(np.argmax(w))]; axis = axis / np.linalg.norm(axis)
        if axis[1] < 0:
            axis = -axis
        y = np.array([0, 1.0, 0]); a = np.cross(axis, y)
        s = np.linalg.norm(a); cdot = float(np.dot(axis, y))
        if s < 1e-8:
            R = np.eye(3)
        else:
            a = a / s
            K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
            R = np.eye(3) + s * K + (1 - cdot) * (K @ K)
        conf = min(0.95, 0.55 + 0.12 * (aspect_long - 2.2))
        return _entry("y", euler_xyz_from_matrix(R), round(conf, 2), "auto",
                      f"Elongated (aspect {aspect_long:.1f}); PCA long-axis aligned to vertical.")

    # --- general => stable-pose solve, pick the upright candidate ---
    try:
        transforms, probs = trimesh.poses.compute_stable_poses(m, n_samples=2, threshold=0.0)
    except Exception as e:
        return _entry("auto", [0, 0, 0], 0.2, "review", f"Stable-pose solve failed ({e}).")
    if len(transforms) == 0:
        return _entry("auto", [0, 0, 0], 0.2, "review", "No stable pose found.")

    scores = []
    for i, T in enumerate(transforms[:4]):
        Rnet = Rx(-90) @ T[:3, :3]                 # trimesh z-up rest -> viewer y-up
        Vp = V @ Rnet.T
        h = np.ptp(Vp[:, 1])                        # vertical extent after pose
        foot = np.ptp(Vp[:, 0]) * np.ptp(Vp[:, 2])  # base footprint
        scores.append(float(probs[i]) * (h ** 1.5) / (foot + 1e-6))  # tall+stable+small base
    order = np.argsort(scores)[::-1]
    best_i = int(order[0])
    Rnet = Rx(-90) @ transforms[best_i][:3, :3]
    # confidence from how decisively the best pose beat the runner-up
    top, second = scores[order[0]], (scores[order[1]] if len(order) > 1 else 0.0)
    margin = (top - second) / (top + 1e-9)
    conf = round(max(0.3, min(0.9, 0.5 + 0.45 * margin)), 2)
    flag = "auto" if conf >= 0.6 else "review"
    return _entry("y", euler_xyz_from_matrix(Rnet), conf, flag,
                  f"Stable-pose solve (pose {best_i}, p={probs[best_i]:.2f}, margin {margin:.2f}); "
                  f"{'confident' if flag == 'auto' else 'ambiguous - review'}.")


def _entry(up, model_rotation, confidence, flag, reason):
    return dict(upAxis=up, modelRotation=[float(x) for x in model_rotation],
                yaw=0, confidence=confidence, flag=flag, reason=reason)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mesh")
    ap.add_argument("--slug", default=None)
    args = ap.parse_args()
    m = load_mesh(args.mesh)
    out = propose(m)
    integ = integrity(m)
    out["integrity"] = integ
    # quality gate: shattered/holey source should be re-fetched, not published
    if integ["ncomp"] > 50 or integ["bratio"] > 0.3:
        out["flag"] = "review"
        out["reason"] += (f" QUALITY: ncomp={integ['ncomp']} bratio={integ['bratio']} "
                          "- source may be shattered/open; re-fetch a better scan.")
    if args.slug:
        out = {"slug": args.slug, **out}
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
