# 线上验证：「换一批」修复是否已在真实云环境生效。
#
# 用法（需开发者工具已打开本项目窗口、且部署确认已点过）：
#   powershell -File tools\verify-recommend-live.ps1
# 结果写入 D:\wx\_verify.txt，用 Read 工具查看。
#
# 判据：
#   hasUnseen=true            → 新后端已上线（旧版本没有 unseen 字段）
#   b1 与 b2 重叠数 = 0       → 换一批真的会换
#   b3 与 b2 重叠数 <= 2      → 累计排除生效
#   任一批 len 为 0           → 有 bug

$ErrorActionPreference = 'Continue'
$exe  = "D:\微信web开发者工具\wechatide.cmd"
$proj = "D:\wx\campus-xianyu"
$log  = @()

function Eval($label, $fn) {
  $out = & $exe -c CodeBuddyCode automation_evaluate --project $proj --fn-source $fn 2>&1 | Out-String
  $script:log += "--- $label ---"
  $script:log += $out
  $script:log += ""
  return $out
}

# 1) 拿 token（本项目的联调登录口）
Eval "login" "function(){ return wx.cloud.callFunction({name:'campus',data:{path:'/api/login',method:'POST',data:{testUserId:2},token:'',scope:'api'}}).then(function(r){ wx.setStorageSync('vtoken', r.result.data.token); return 'LOGIN_OK user=' + r.result.data.user.nickname }).catch(function(e){ return 'ERR ' + String(e&&e.errMsg) }) }" | Out-Null

# 2) 第一批
Eval "batch1" "function(){ var t=wx.getStorageSync('vtoken'); return wx.cloud.callFunction({name:'campus',data:{path:'/api/recommend/home?seed=1',method:'GET',data:null,token:t,scope:'api'}}).then(function(r){ var d=r.result.data||{}; var L=d.list; var ids=Array.isArray(L)?L.map(function(x){return x.id}):[]; wx.setStorageSync('b1', ids.join(',')); return 'RESULT code='+r.result.code+' isArray='+Array.isArray(L)+' len='+ids.length+' hasUnseen='+(typeof d.unseen==='number')+' unseen='+d.unseen+' pool='+d.poolSize+' ids='+ids.join(',') }).catch(function(e){ return 'ERR '+String(e&&e.errMsg) }) }" | Out-Null

# 3) 第二批：排除第一批
Eval "batch2" "function(){ var t=wx.getStorageSync('vtoken'); var b1=wx.getStorageSync('b1'); return wx.cloud.callFunction({name:'campus',data:{path:'/api/recommend/home?seed=2&exclude='+b1,method:'GET',data:null,token:t,scope:'api'}}).then(function(r){ var d=r.result.data||{}; var L=d.list; var ids=Array.isArray(L)?L.map(function(x){return x.id}):[]; var arr1=String(b1).split(','); var dup=ids.filter(function(i){return arr1.indexOf(String(i))>-1}).length; return 'RESULT len='+ids.length+' dupWithBatch1='+dup+' unseen='+d.unseen }).catch(function(e){ return 'ERR '+String(e&&e.errMsg) }) }" | Out-Null

Set-Content -Path "D:\wx\_verify.txt" -Value ($log -join "`n") -Encoding UTF8
"written len=" + ($log -join "`n").Length
