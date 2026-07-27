/**
 * Icon adapter layer.
 *
 * Primary:  @tabler/icons-react  (all general-purpose icons)
 * Fallback: react-icons         (Tabler-uncovered sets: Phosphor, Remix, brand icons)
 *
 * Convention:
 *   - Tabler icons are re-exported under their original PascalCase name (e.g. IconX).
 *   - Commonly used icons get a shorthand alias (e.g. XIcon = IconX) for brevity.
 *   - react-icons icons are prefixed per set: Pi*, Ri*, Si*, Vsc*.
 *
 * Usage in components:
 *   import { IconX, IconSettings, IconBolt } from "@renderer/lib/icons.js";
 *   <IconX size={16} className="text-content-muted" />
 */

/* ───────── Tabler icons (primary) ───────── */
export type { IconProps as TablerIconProps } from "@tabler/icons-react";

export {
  // Actions
  IconX,
  IconCheck,
  IconPlus,
  IconMinus,
  IconEdit,
  IconTrash,
  IconCopy,
  IconSearch,
  IconFilter,
  IconDownload,
  IconUpload,
  IconRefresh,
  IconShare,
  IconSend,
  IconSend2,
  IconArchive,
  // Navigation
  IconChevronDown,
  IconChevronUp,
  IconChevronLeft,
  IconChevronRight,
  IconArrowRight,
  IconArrowLeft,
  IconArrowUp,
  IconArrowDown,
  IconMenu2,
  IconDots,
  IconDotsVertical,
  // Status / feedback
  IconInfoCircle,
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleXFilled,
  IconLoader2,
  // Media / content
  IconPlayerPlay,
  IconPlayerStop,
  IconPlayerPause,
  IconPlayerSkipForward,
  IconBolt,
  IconStar,
  IconTools,
  IconPrompt,
  IconHeart,
  IconEye,
  IconEyeOff,
  IconCode,
  IconTerminal2,
  IconFile,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  // Communication
  IconMessage,
  IconMessages,
  IconMail,
  IconBell,
  IconSettings,
  IconUser,
  IconUsers,
  IconHelpCircle,
  IconQuestionMark,
  // Layout / window
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightExpand,
  IconColumns3,
  IconMaximize,
  IconMinimize,
  IconExternalLink,
  IconGripHorizontal,
  IconGripVertical,
  // Objects
  IconKey,
  IconLink,
  IconUnlink,
  IconLock,
  IconLockOpen,
  IconClock,
  IconCalendar,
  IconHash,
  IconTag,
  IconTags,
  IconBookmark,
  IconBook,
  IconFlask,
  IconPalette,
  IconDeviceFloppy,
  IconSelector,
  IconAdjustmentsHorizontal,
  IconList,
  IconListDetails,
  IconLanguage,
  IconGlobe,
  IconSun,
  IconMoon,
  // Status-capsule icons
  IconHexagon,
  IconRobot,
  IconCpu,
  // Theme picker icons
  IconDeviceDesktop,
} from "@tabler/icons-react";

/* ───────── Shorthand aliases (commonly used) ───────── */
export { IconX as XIcon } from "@tabler/icons-react";
export { IconCheck as CheckIcon } from "@tabler/icons-react";
export { IconPlus as PlusIcon } from "@tabler/icons-react";
export { IconEdit as EditIcon } from "@tabler/icons-react";
export { IconTrash as TrashIcon } from "@tabler/icons-react";
export { IconCopy as CopyIcon } from "@tabler/icons-react";
export { IconSearch as SearchIcon } from "@tabler/icons-react";
export { IconSettings as SettingsIcon } from "@tabler/icons-react";
export { IconBolt as BoltIcon } from "@tabler/icons-react";
export { IconDots as DotsIcon } from "@tabler/icons-react";
export { IconDotsVertical as DotsVerticalIcon } from "@tabler/icons-react";
export { IconFolder as FolderIcon } from "@tabler/icons-react";
export { IconMessage as MessageIcon } from "@tabler/icons-react";
export { IconCode as CodeIcon } from "@tabler/icons-react";
export { IconTerminal2 as TerminalIcon } from "@tabler/icons-react";
export { IconGlobe as GlobeIcon } from "@tabler/icons-react";
export { IconKey as KeyIcon } from "@tabler/icons-react";
export { IconSun as SunIcon } from "@tabler/icons-react";
export { IconMoon as MoonIcon } from "@tabler/icons-react";
export { IconChevronDown as ChevronDownIcon } from "@tabler/icons-react";
export { IconChevronRight as ChevronRightIcon } from "@tabler/icons-react";
export { IconArrowRight as ArrowRightIcon } from "@tabler/icons-react";
export { IconInfoCircle as InfoIcon } from "@tabler/icons-react";
export { IconAlertTriangle as WarningIcon } from "@tabler/icons-react";
export { IconAlertCircle as AlertIcon } from "@tabler/icons-react";
export { IconLoader2 as SpinnerIcon } from "@tabler/icons-react";
export { IconMenu2 as MenuIcon } from "@tabler/icons-react";
export { IconExternalLink as ExternalLinkIcon } from "@tabler/icons-react";

/* ───────── react-icons (auxiliary sets — only when Tabler lacks an icon) ───────── */

// Phosphor icons
export { PiSquareSplitHorizontal } from "react-icons/pi";

// Remix icons
export { RiApps2Line } from "react-icons/ri";

// Simple Icons (brands)
export { SiGithub } from "react-icons/si";

// VS Code icons
export { VscMcp } from "react-icons/vsc";
