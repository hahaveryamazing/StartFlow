# Native integration fixture only. StartFlow never accepts or executes scripts as tasks.
param([Parameter(Mandatory=$true)][string]$ReadyFile,[string]$HotkeyReadyFile='')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StartFlowProbeNative {
 [DllImport("user32.dll",SetLastError=true)] public static extern bool RegisterHotKey(IntPtr h,int id,uint modifiers,uint key);
 [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h,int id);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
}
'@
$one=New-Object System.Windows.Forms.Form
$one.Text='StartFlow V2 Window Fixture A'
$one.StartPosition='Manual'
$one.Location=New-Object System.Drawing.Point(70,100)
$one.Size=New-Object System.Drawing.Size(500,400)
$two=New-Object System.Windows.Forms.Form
$two.Text='StartFlow V2 Window Fixture B'
$two.StartPosition='Manual'
$two.Location=New-Object System.Drawing.Point(620,150)
$two.Size=New-Object System.Drawing.Size(500,400)
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=500
$timer.Add_Tick({[void][StartFlowProbeNative]::ShowWindow($one.Handle,5);$two.Show();Set-Content -LiteralPath $ReadyFile -Value 'ready' -Encoding utf8;$timer.Stop()})
$one.Add_Shown({$timer.Start()})
if($HotkeyReadyFile){
 if(-not [StartFlowProbeNative]::RegisterHotKey([IntPtr]::Zero,4401,3,0x76)){throw 'Fixture hotkey unavailable'}
 Set-Content -LiteralPath $HotkeyReadyFile -Value 'registered' -Encoding utf8
}
try{[System.Windows.Forms.Application]::Run($one)}finally{if($HotkeyReadyFile){[void][StartFlowProbeNative]::UnregisterHotKey([IntPtr]::Zero,4401)};$two.Dispose();$one.Dispose()}
