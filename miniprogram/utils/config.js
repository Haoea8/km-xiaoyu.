/**
 * 全局配置
 * 说明：项目已迁移到微信云开发，所有后端能力走云函数 campus，不再依赖本地服务器。
 */
module.exports = {
  /**
   * 本地 REST 开关（留空 = 自动）。
   *
   * 留空时的行为（默认，无需任何配置）：
   *   · 在**开发者工具**里跑（开发版）→ 自动尝试连 `http://127.0.0.1:3000`；
   *     连上了就用本地后台，于是「小程序里增删改 → 后台立刻能看到」，共用 server/data/db.json；
   *     连不上（本机没起 server）→ 自动回退云函数，不报错。
   *   · 体验版 / 正式版 → 永不连本地，直接走云函数（手机上的用户不受影响）。
   *
   * 也可以显式指定地址（此时不再判断运行版本，任何环境都连它）：
   *   LOCAL_API: 'http://127.0.0.1:3000'
   *
   * 评委本地验收步骤（约 3 分钟）：
   *   1. 双击 start-admin.cmd（或 node server/src/index.js）启动后台，窗口别关
   *   2. 开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名、web-view…」
   *   3. 重新编译（Ctrl+B），之后在模拟器里的操作都会写进本地库
   *
   * 注意：真机上 127.0.0.1 指向手机自己，所以真机永远走云函数，这条只服务于本地验收。
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
