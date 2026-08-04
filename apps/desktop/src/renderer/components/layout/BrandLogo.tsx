import { cn } from "@renderer/lib/cn.js";
// 与打包用的应用图标(build/icon.png)是同一张图,保证左栏 logo 与安装包 /
// 任务栏图标完全一致。资源放在 src/renderer/ 下,走 vite 静态资源管线
// (与 favicon.png 同目录、同引用方式)。
import brandLogoUrl from "@renderer/brand-logo.png";

interface BrandLogoProps {
  /** Logo 边长(px)。默认 28。 */
  size?: number;
  className?: string;
}

/** Mcode 应用品牌 logo。
 *
 * 直接引用打包用的 `icon.png`(深蓝紫渐变 + 字母 M),与应用图标完全统一。
 * 外层用 `rounded-[28%]` 微圆角包裹原始方形图,边缘加一圈极淡的描边
 * (border-edge/40)使 logo 在浅色/深色面板背景上都有清晰边界。 */
export function BrandLogo({ size = 28, className }: BrandLogoProps) {
  return (
    <div
      className={cn(
        "shrink-0 overflow-hidden rounded-[28%] border border-edge/40 shadow-sm",
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img
        src={brandLogoUrl}
        alt=""
        width={size}
        height={size}
        // draggable={false} 避免用户意外拖拽图片;decoding="async" 不阻塞渲染。
        draggable={false}
        decoding="async"
        className="h-full w-full select-none object-cover"
      />
    </div>
  );
}
