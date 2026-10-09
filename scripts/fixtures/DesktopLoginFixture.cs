// Dedicated synthetic Win32 application. Never use real account data in this fixture.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
class DesktopLoginFixture {
    delegate IntPtr Proc(IntPtr h,uint msg,IntPtr w,IntPtr l);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Class { public uint style; public Proc proc; public int extra,windowExtra; public IntPtr instance,icon,cursor,background; public string menu,name; }
    [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr h;public uint message;public IntPtr w,l;public uint time;public int x,y;public uint priv; }
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClassW(ref Class c);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex,string cls,string name,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h,uint m,IntPtr w,IntPtr l);
    [DllImport("user32.dll")] static extern bool GetMessageW(out Msg m,IntPtr h,uint a,uint b);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Msg m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref Msg m);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int command);
    [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr h,bool enabled);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h,StringBuilder text,int size);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool SetWindowTextW(IntPtr h,string text);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h,uint msg,IntPtr w,IntPtr l);
    [DllImport("user32.dll")] static extern void PostQuitMessage(int exit);
    static IntPtr main,user,password,button,success,identity,failure,challenge;
    static Proc callback=WindowProc;static string mode,path;static int submissions;static bool logged,blockProvider;
    const uint child=0x40000000,visible=0x10000000;
    static IntPtr Control(string cls,string text,int id,int y,uint extra,bool show) { return CreateWindowExW(0,cls,text,child|(show?visible:0)|extra,30,y,370,32,main,new IntPtr(id),IntPtr.Zero,IntPtr.Zero); }
    static void State(){File.WriteAllText(path,"{\"submissions\":"+submissions+",\"logged\":"+(logged?"true":"false")+",\"armed\":"+(blockProvider?"true":"false")+"}");}
    static string Text(IntPtr h){var b=new StringBuilder(512);GetWindowTextW(h,b,512);return b.ToString();}
    static void Complete(string username){logged=true;ShowWindow(user,0);ShowWindow(password,0);ShowWindow(button,0);ShowWindow(failure,0);ShowWindow(challenge,mode=="success-challenge"?5:0);SetWindowTextW(identity,username);ShowWindow(success,5);ShowWindow(identity,5);State();}
    static void Reset(){logged=false;ShowWindow(success,0);ShowWindow(identity,0);ShowWindow(failure,0);ShowWindow(challenge,mode=="challenge"?5:0);ShowWindow(user,5);ShowWindow(password,5);ShowWindow(button,5);SetWindowTextW(user,"");SetWindowTextW(password,"");State();}
    static IntPtr WindowProc(IntPtr h,uint msg,IntPtr w,IntPtr l){
        if(blockProvider && msg==0x3d)Thread.Sleep(30000);
        if(msg==0x8003){blockProvider=true;State();return IntPtr.Zero;}
        if(msg==2){PostQuitMessage(0);return IntPtr.Zero;}
        if(msg==0x8001){Complete("demo1@example.test");return IntPtr.Zero;}
        if(msg==0x8002){Reset();return IntPtr.Zero;}
        if(msg==0x111 && (w.ToInt64()&65535)==1003){
            submissions++;State();
            if(mode=="after-challenge"){ShowWindow(challenge,5);return IntPtr.Zero;}
            if(mode=="timeout"){return IntPtr.Zero;}
            if(mode=="fail"||Text(password)!="StartFlowSynthetic-only"||!Text(user).EndsWith("@example.test")){ShowWindow(failure,5);return IntPtr.Zero;}
            Complete(Text(user));return IntPtr.Zero;
        }
        return DefWindowProcW(h,msg,w,l);
    }
    static void Main(string[] args){
        mode=args[0];path=args[1];var c=new Class{proc=callback,name="StartFlowLoginFixture",background=new IntPtr(6)};RegisterClassW(ref c);
        main=CreateWindowExW(0,c.name,"StartFlow UIA Fixture "+mode,0x10CF0000,150,150,470,500,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
        Control("STATIC","Synthetic login fixture",1100,20,0,true);
        user=Control("EDIT","",1001,70,0x00800000,true);
        password=Control("EDIT","",1002,115,mode=="unsupported"?0x00800820u:0x00800020u,true);
        button=Control("BUTTON","Sign in",1003,160,0,true);
        success=Control("STATIC","Signed in",1004,215,0,false);
        identity=Control("STATIC","demo1@example.test",1005,255,0,false);
        failure=Control("STATIC","Login rejected",1006,300,0,false);
        challenge=Control("STATIC","MFA verification code required",1007,350,0,mode=="challenge");
        if(mode=="duplicates")Control("EDIT","",1001,400,0x00800000,true);
        if(main==IntPtr.Zero)throw new Exception("Fixture window creation failed");
        ShowWindow(main,5);ShowWindow(main,5);
        if(mode=="disabled")EnableWindow(main,false);
        State();new Thread(()=>{string line;while((line=Console.ReadLine())!=null){if(line=="show-success")PostMessageW(main,0x8001,IntPtr.Zero,IntPtr.Zero);if(line=="reset")PostMessageW(main,0x8002,IntPtr.Zero,IntPtr.Zero);if(line=="hang")PostMessageW(main,0x8003,IntPtr.Zero,IntPtr.Zero);}}){IsBackground=true}.Start();
        Msg m;while(GetMessageW(out m,IntPtr.Zero,0,0)){TranslateMessage(ref m);DispatchMessageW(ref m);}
    }
}
