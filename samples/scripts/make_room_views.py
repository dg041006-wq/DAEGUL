"""
Poly Haven 'Small Empty Room 1'(CC0, Sergej Majboroda) 등장방형 사진에서
알려진 카메라(초점·회전)로 원근 시점 사진을 잘라내고, 정답(ground truth) 카메라와
기준점 좌표를 함께 기록한다.

- 사진 자체는 실제 촬영본(파노라마의 톤매핑 JPG)이며, 크롭은 원근 재투영(쌍선형 보간)이다.
- 모든 시점은 같은 촬영 위치(순수 회전)에서 나온다. 시차(parallax)가 있는 다시점 검증은 아님.
- 스케일 근거: 문 높이 2.00m 가정 → 촬영 높이 약 1.40m (문 손잡이 높이 0.93m로 교차 확인).
  실측값이 아니므로 앱에서는 '추정 스케일'로 다룬다.

실행: python3 samples/scripts/make_room_views.py
"""
import json, math, os, sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "source", "small_empty_room_1_tonemapped.jpg")
OUT = os.path.join(ROOT, "room")
os.makedirs(OUT, exist_ok=True)

H_CAM = 1.40  # m, 문 높이 2.00m 가정에서 역산 (실측 아님)

pano = np.asarray(Image.open(SRC).convert("RGB"))
PH, PW = pano.shape[:2]


def pano_dir(px, py):
    lon = (px / PW - 0.5) * 2 * math.pi
    lat = (0.5 - py / PH) * math.pi
    return np.array([math.sin(lon) * math.cos(lat), math.sin(lat), -math.cos(lon) * math.cos(lat)])


CAM = np.array([0.0, H_CAM, 0.0])


def floor_point(px, py):
    d = pano_dir(px, py)
    assert d[1] < 0
    return CAM + d * (H_CAM / -d[1])


# 걸레받이 하단(밝은 벽→어두운 바닥) 경계를 열마다 자동 추적해 왼쪽 긴 벽(벽지·콘센트 벽)의 바닥선을 맞춘다.
gray = pano.astype(np.float32).mean(-1)
wall_pts = []
for x in range(2112, 3800, 16):
    col = np.convolve(gray[2450:3500, x], np.ones(5) / 5, "same")
    g = col[:-6] - col[6:]
    i = int(np.argmax(g[5:-5])) + 5
    y = 2450 + i + 3
    if g[i] > 25 and y > 2700:
        q = floor_point(x, y)
        wall_pts.append([q[0], q[2]])
wall_pts = np.array(wall_pts)
c0 = wall_pts.mean(0)
_, _, vt = np.linalg.svd(wall_pts - c0)
dirv = vt[0]
if dirv[1] > 0:  # 창 쪽(-z, 파노라마 정면)으로 향하게
    dirv = -dirv
resid = (wall_pts - c0) @ vt[1]
for _ in range(3):  # 이상치(커튼·문틀 등 오검출) 제거 후 재적합
    keep = np.abs(resid) < max(0.03, 2.5 * np.median(np.abs(resid)))
    wall_pts = wall_pts[keep]
    c0 = wall_pts.mean(0)
    _, _, vt = np.linalg.svd(wall_pts - c0)
    if np.dot(vt[0], dirv) < 0:
        vt[0] = -vt[0]
    dirv = vt[0]
    resid = (wall_pts - c0) @ vt[1]
WALL_FIT_N = int(len(wall_pts))
WALL_FIT_RMS = float(np.sqrt((resid ** 2).mean()))

A = floor_point(2765, 3070)  # 벽지 끝선과 바닥 경계(걸레받이 하단)
# 원점: A를 맞춘 벽선 위로 사영
t = np.dot(np.array([A[0], A[2]]) - c0, dirv)
o2 = c0 + t * dirv
A = np.array([o2[0], 0.0, o2[1]])
xh = np.array([dirv[0], 0.0, dirv[1]])
yh = np.array([0.0, 1.0, 0.0])
zh = np.cross(xh, yh)
if np.dot(CAM - A, zh) < 0:
    raise SystemExit("world frame orientation unexpected")
M = np.stack([xh, yh, zh])  # rows: world axes in pano frame


def to_world(p):
    return M @ (p - A)


def wall_point(px, py, origin, normal):
    d = pano_dir(px, py)
    s = np.dot(origin - CAM, normal) / np.dot(d, normal)
    return CAM + s * d


points = {
    "P1": ("벽지 끝선 아래 바닥 경계", to_world(A)),
    "P2": ("오른쪽 벽 바닥 모서리(창 옆)", to_world(floor_point(5840, 2816))),
    "P3": ("왼쪽 커튼 바깥 끝단(바닥)", to_world(floor_point(4019, 2873))),
    "P4": ("왼쪽 커튼 안쪽 끝단(바닥)", to_world(floor_point(4526, 3005))),
    "P5": ("오른쪽 커튼 안쪽 끝단(바닥)", to_world(floor_point(5299, 2985))),
    "P6": ("오른쪽 커튼 바깥 끝단(바닥)", to_world(floor_point(5688, 2941))),
    "P7": ("4구 콘센트 중심(왼쪽)", to_world(wall_point(3220, 2477, A, zh))),
    "P8": ("4구 콘센트 중심(오른쪽)", to_world(wall_point(3582, 2435, A, zh))),
    "P9": ("에어컨 왼쪽 아래 모서리", to_world(wall_point(3514, 1573, A, zh))),
}
cam_world = to_world(CAM)


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def render_view(name, yaw_deg, pitch_deg, hfov_deg, W, Hh):
    f = (W / 2) / math.tan(math.radians(hfov_deg) / 2)
    cx, cy = W / 2, Hh / 2
    R_pano_cam = rot_y(-math.radians(yaw_deg)) @ rot_x(math.radians(pitch_deg))
    u, v = np.meshgrid(np.arange(W) + 0.5, np.arange(Hh) + 0.5)
    dc = np.stack([(u - cx) / f, -(v - cy) / f, -np.ones_like(u)], -1)
    d = dc @ R_pano_cam.T
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    lon = np.arctan2(d[..., 0], -d[..., 2])
    lat = np.arcsin(np.clip(d[..., 1], -1, 1))
    px = (lon / (2 * math.pi) + 0.5) * PW - 0.5
    py = (0.5 - lat / math.pi) * PH - 0.5
    x0 = np.floor(px).astype(np.int64); y0 = np.floor(py).astype(np.int64)
    fx = (px - x0)[..., None]; fy = (py - y0)[..., None]
    x1 = (x0 + 1) % PW; x0 %= PW
    y0 = np.clip(y0, 0, PH - 1); y1 = np.clip(y0 + 1, 0, PH - 1)
    p = pano.astype(np.float32)
    out = (p[y0, x0] * (1 - fx) * (1 - fy) + p[y0, x1] * fx * (1 - fy) + p[y1, x0] * (1 - fx) * fy + p[y1, x1] * fx * fy)
    img = Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8))
    # 실제 카메라처럼 EXIF 35mm 환산 초점거리(정수 mm)를 기록한다. 긴 변 = 36mm 기준.
    f35 = int(round(f / max(W, Hh) * 36))
    exif = Image.Exif()
    exif[0x010F] = "SAMPLE"
    exif[0x0110] = "Poly Haven pano crop"
    exif[0x0112] = 1
    ifd = exif.get_ifd(0x8769)
    ifd[0xA405] = f35
    img.save(os.path.join(OUT, f"{name}.jpg"), quality=95, subsampling=0, exif=exif)
    # 정답 카메라 (world): R_world_cam = M @ R_pano_cam
    R = M @ R_pano_cam
    proj = {}
    for k, (_, P) in points.items():
        pc = R.T @ (P - cam_world)
        if pc[2] >= -1e-6:
            continue
        uu = cx + f * pc[0] / -pc[2]
        vv = cy - f * pc[1] / -pc[2]
        if 0 <= uu < W and 0 <= vv < Hh:
            proj[k] = [round(float(uu), 2), round(float(vv), 2)]
    return {
        "file": f"{name}.jpg", "width": W, "height": Hh,
        "yawDeg": yaw_deg, "pitchDeg": pitch_deg, "hfovDeg": hfov_deg,
        "f": f, "cx": cx, "cy": cy, "exifFocal35mm": int(round(f / max(W, Hh) * 36)),
        "R_world_cam": R.tolist(), "center": cam_world.tolist(),
        "points": proj,
    }


views = [
    render_view("view1", -28, -16, 100, 2400, 1600),
    render_view("view2", 24, -14, 90, 2400, 1600),
    render_view("view3", -45, -24, 62, 2400, 1600),
]
gt = {
    "source": "Poly Haven — Small Empty Room 1 (CC0), tonemapped JPG 8192x4096",
    "scaleBasis": "문 높이 2.00m 가정 → 촬영 높이 1.40m (실측 아님)",
    "cameraHeightM": H_CAM,
    "worldFrame": "원점 P1, X축 왼쪽 긴 벽(벽지·콘센트 벽) 바닥선 방향(창 쪽), Y 위, Z 방 안쪽. 단위 m",
    "wallFitRmsM": WALL_FIT_RMS, "wallFitPoints": WALL_FIT_N,
    "points": {k: {"label": lbl, "world": [round(float(c), 4) for c in P]} for k, (lbl, P) in points.items()},
    "views": views,
}
with open(os.path.join(OUT, "ground_truth.json"), "w", encoding="utf-8") as fp:
    json.dump(gt, fp, ensure_ascii=False, indent=1)
print(json.dumps({k: v["world"] for k, v in gt["points"].items()}, indent=0))
for v in views:
    print(v["file"], round(v["f"], 1), v["points"])
