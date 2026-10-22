//#region src/classify.d.ts
/** 分类所需的路径事实。 */
interface ClassifyEnv {
  /** 用户主目录（`os.homedir()`）。 */
  home: string;
  /** 当前会话工作目录。 */
  workdir: string;
  /** DSH 安装目录；提供时其下所有内容受保护。 */
  installDir?: string;
  /** DSH_HOME；默认 `<home>/.dsh`。 */
  dshHome?: string;
  /**
   * 系统临时目录。默认取 `os.tmpdir()`。
   *
   * 必须单独豁免：Windows 上 `%TEMP%` 位于 `C:\Users\<user>\AppData\Local\Temp`，
   * 也就是**在家目录里面**。若不豁免，删任何一个临时文件都会弹审批卡 ——
   * 真实使用中这正是被抱怨的那类打扰。
   */
  tmpdir?: string;
  /**
   * 安全区状态目录的实际位置。
   *
   * 默认按 `<dshHome>/.dsh-safe-delete` 推导，但 `stateDir` 是可配置的 ——
   * 配到别处时若不显式告知，安全区自身就会失去保护。
   */
  safeZoneDir?: string;
}
//#endregion
export { ClassifyEnv as t };