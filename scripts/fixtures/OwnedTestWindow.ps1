param([int]$ProcessId, [ValidateSet('handle','close','visible','show')][string]$Action, [long]$HandleValue = 0)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Runtime.InteropServices;
public class OwnedTestWindow {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h,uint msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
}
'@
$testProcess=Get-Process -Id $ProcessId
if($Action -eq 'handle') { $testProcess.MainWindowHandle.ToInt64(); exit }
$testHandle=[IntPtr]$HandleValue
[uint32]$actualPid=0
[void][OwnedTestWindow]::GetWindowThreadProcessId($testHandle,[ref]$actualPid)
if($actualPid -ne $ProcessId) { throw 'Target is not the owned test window.' }
switch($Action) {
 'close' { if(-not [OwnedTestWindow]::PostMessageW($testHandle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Could not close test window.'} }
 'visible' { [OwnedTestWindow]::IsWindowVisible($testHandle) }
 'show' { [void][OwnedTestWindow]::ShowWindow($testHandle,5) }
}
