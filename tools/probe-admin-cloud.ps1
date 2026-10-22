$ErrorActionPreference = 'Continue'
$exe  = "D:\微信web开发者工具\wechatide.cmd"
$proj = "D:\wx\campus-xianyu"
$log  = @()

function Eval($label, $fn) {
  $out = & $exe -c CodeBuddyCode automation_evaluate --project $proj --fn-source $fn 2>&1 | Out-String
  $script:log += "--- $label ---"
  $script:log += $out
  $script:log += ""
}

# 1) 云函数是否可达
Eval "alive" "function(){ return 'ALIVE' }"

# 2) 云端 admin 登录（admin/admin）—— 这一步同时验证部署与自愈是否生效
Eval "admin-login" "function(){ return wx.cloud.callFunction({name:'campus',data:{path:'/admin-api/login',method:'POST',data:{username:'admin',password:'admin'},token:'',scope:'api'}}).then(function(r){ var d=r.result.data||{}; if(d.token) wx.setStorageSync('atoken', d.token); return 'code='+r.result.code+' hasToken='+(!!d.token)+' username='+d.username+' msg='+(r.result.message||'-') }).catch(function(e){ return 'ERR '+String(e&&e.errMsg) }) }"

Set-Content -Path "D:\wx\_adm.txt" -Value ($log -join "`n") -Encoding UTF8
"written len=" + ($log -join "`n").Length
