/**
 * 全局配置
 * 说明：项目已迁移到微信云开发，所有后端能力走云函数 campus，不再依赖本地服务器。
 */
module.exports = {
  /** 云开发环境 ID（在微信开发者工具 → 云开发控制台可查看） */
  CLOUD_ENV: 'cloud1-d1gm4yssj28112256',

  /**
   * 云存储桶 ID。
   *
   * 云存储 fileID 的格式是：
   *   cloud://<环境ID>.<存储桶ID>/<文件路径>
   *
   * 注意第二段是「存储桶 ID」，不是环境 ID。写成 envId.envId 会让
   * image 组件把 fileID 当成相对路径，报
   *   Failed to load image http://127.0.0.1:xxxx/__pageframe__/pages/index/cloud://...
   *
   * 存储桶 ID 可从云存储文件的 storageCdnDomain（形如 636c-<envId>-<appid>）
   * 或「云开发控制台 → 存储 → 文件详情」确认。
   */
  CLOUD_BUCKET: '636c-cloud1-d1gm4yssj28112256-1505193768',

  /** 主云函数名（承载全部业务接口） */
  CLOUD_FN: 'campus',

  /** 云存储根目录 */
  CLOUD_PATH: 'campus/'
};
