//#region src/settings-guide.d.ts
/**
 * 配置项的人话说明与解析。
 *
 * 为什么单独成模块：斜杠命令里 `config` 的每一项都要说清「它管什么、单位是什么、
 * 改成大一点或小一点会发生什么」。这些文案是产品的一部分，不该散落在命令处理里
 * —— 而且它需要被测试钉住（参数说明缺失 = 用户配置时只能靠猜）。
 *
 * @module dsh-safe-delete/settings-guide
 */
/** 一个可配置项的完整说明。 */
export interface SettingGuide {
  /** 配置键（与 `Config` 中的字段一致）。 */
  key: string;
  /** 单位（用于显示与解析）。 */
  unit: 'bytes' | 'milliseconds' | 'percent' | 'count' | 'days' | 'boolean';
  /** 一句话：它管什么。 */
  summary: string;
  /** 调大 / 调小分别会发生什么。 */
  effect: string;
  /** 合法范围的人话描述。 */
  range: string;
  /** 默认值（原始单位）。 */
  defaultValue: number | boolean;
}
/**
 * 全部可配置项的说明。
 *
 * 顺序即 `/safe-delete config` 的展示顺序。
 */
export declare const SETTING_GUIDES: readonly SettingGuide[];
/** 按 key 查说明。 */
export declare function guideOf(key: string): SettingGuide | undefined;
/** 人类可读的体积。 */
export declare function humanBytes(bytes: number): string;
/** 人类可读的时长。 */
export declare function humanDuration(ms: number): string;
/**
 * 把配置值格式化成带单位的可读文本。
 */
export declare function formatSetting(guide: SettingGuide, value: unknown): string;
/** 解析结果。 */
export type ParseSetting = {
  ok: true;
  value: number | boolean;
} | {
  ok: false;
  error: string;
};
/**
 * 解析用户输入的值。
 *
 * 支持带单位的写法（`20GB`、`500MB`、`2h`、`30min`），也支持纯数字
 * （按该字段的单位解释）。范围检查与说明里的 `range` 保持一致。
 */
export declare function parseSetting(guide: SettingGuide, raw: string): ParseSetting;
//#endregion