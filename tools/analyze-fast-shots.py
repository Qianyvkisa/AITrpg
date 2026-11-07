# ---------------------------------------------------------------------------
# 分析快速启动截图：确认动画窗口在何时出现、是否真的在动
#
# 判据分两层，缺一不可：
#   1. 「出现」：某一帧开始，屏幕中央出现了一块与桌面明显不同的区域
#   2. 「在动」：动画窗口内部的多帧之间有像素变化（静态图不会变）
#
# 只看第 1 层会把静态图也判成合格；只看第 2 层则无法区分「动画」和「主窗口已加载」。
#
# 用法：python tools\analyze-fast-shots.py
# ---------------------------------------------------------------------------
from pathlib import Path
import sys

try:
    from PIL import Image, ImageChops
except ImportError:
    print('需要 Pillow', file=sys.stderr)
    sys.exit(1)

SHOTS = Path(r'D:\Tool\AIrpg\.shots-fast')


def changed_ratio(a, b, threshold=18):
    """两帧之间变化像素占比"""
    diff = ImageChops.difference(a, b).convert('L')
    hist = diff.histogram()
    return sum(hist[threshold + 1:]) / sum(hist) * 100


def center_region(im, w=380, h=300):
    """取屏幕中央与动画窗口等大的区域（窗口是居中的）"""
    W, H = im.size
    left = (W - w) // 2
    top = (H - h) // 2
    return im.crop((left, top, left + w, top + h))


def main():
    files = sorted(SHOTS.glob('*.png'), key=lambda p: int(p.stem[1:].rstrip('ms')))
    if not files:
        print('没有截图')
        return

    ims = [Image.open(f).convert('RGB') for f in files]
    centers = [center_region(im) for im in ims]

    print(f'{"时间点":<12} {"中央区与首帧差异":<18} {"中央区与上帧差异":<18}')
    print('-' * 56)

    appear_at = None
    for i, f in enumerate(files):
        vs_first = changed_ratio(centers[0], centers[i])
        vs_prev = 0.0 if i == 0 else changed_ratio(centers[i - 1], centers[i])

        # 中央区域相对首帧出现明显变化 = 动画窗口已经画出来了
        if appear_at is None and vs_first > 1.5:
            appear_at = f.stem

        print(f'{f.stem:<12} {vs_first:>8.2f}%          {vs_prev:>8.2f}%')

    print()
    if appear_at:
        print(f'动画窗口首次出现于 {appear_at}')
    else:
        print('★ 中央区域始终无变化，动画可能没出现')

    # 关键判定：动画出现之后，后续帧之间是否仍在变
    idx = next((i for i, f in enumerate(files) if f.stem == appear_at), None)
    if idx is not None and idx < len(files) - 1:
        moving = any(
            changed_ratio(centers[i - 1], centers[i]) > 0.15
            for i in range(idx + 1, len(files))
        )
        print('动画在动（后续帧仍有变化）' if moving else '★ 画面静止，可能只是一张静态图')


if __name__ == '__main__':
    main()
