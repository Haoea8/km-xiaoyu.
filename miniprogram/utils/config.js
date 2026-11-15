/**
 * 全局配置
 * 说明：项目已迁移到微信云开发，所有后端能力走云函数 campus，不再依赖本地服务器。
 */
module.exports = {
  /**
   * 本地 REST 开关（默认关闭 = 走云函数）。
   *
   * 填上 `http://127.0.0.1:3100` 后，小程序的请求改走本机 server（`node server/src/index.js`），
   * 于是「小程序里发布商品 → 管理后台立刻看得到」，无需任何云开发账号。
   *
   * 用法（评委本地验收 / 二次开发）：
   *   1. 本机起后台：双击 start-admin.cmd 或 node server/src/index.js
   *   2. 把下面这行改成 LOCAL_API: 'http://127.0.0.1:3100'
   *   3. 开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名…」
   *   4. 重新编译，小程序与后台即为同一份数据（server/data/db.json）
   *
   * 注意：真机上 127.0.0.1 指向手机自己，只有开发者工具/模拟器能用；真机验收请改回空串走云函数。
   */
  LOCAL_API: '',

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
