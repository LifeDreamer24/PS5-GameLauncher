// PS5 Game Launcher system helper.
//
// A tiny console program the launcher talks to over stdin/stdout (one JSON
// request per line, one JSON response per line). It exposes things Electron
// cannot reach on its own:
//   * now-playing media from any app (Windows media sessions), incl. cover art
//   * the system master volume / mute and the playback device (Core Audio)
//   * monitor brightness over DDC/CI, with a WMI fallback for laptop panels
//   * Bluetooth: radio on/off, paired devices, scanning, pairing and
//     connecting audio devices
//   * Windows Night Light on/off
//   * controller Guide/PS button + navigation for the in-game overlay
//   * running-game detection and closing games, foreground window handling
//
// Requests are handled on the thread pool, so a slow Bluetooth operation
// never blocks media updates.
//
// Built with the .NET Framework compiler that ships with Windows — see
// build.cmd in this folder.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Windows.Devices.Enumeration;
using Windows.Devices.Radios;
using Windows.Foundation;
using Windows.Media.Control;

// Version details shown in the file's Properties › Details.
[assembly: System.Reflection.AssemblyTitle("PS5 Game Launcher system helper")]
[assembly: System.Reflection.AssemblyProduct("PS5 Game Launcher")]
[assembly: System.Reflection.AssemblyCompany("Aris")]
[assembly: System.Reflection.AssemblyCopyright("Copyright (c) 2026 Aris")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

namespace PS5GameLauncher
{
    static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        static readonly object WriteLock = new object();
        static StreamWriter stdout;

        [MTAThread]
        static void Main()
        {
            AppDomain.CurrentDomain.UnhandledException += (s, e) => GameWin.ResumeAll();
            AppDomain.CurrentDomain.ProcessExit += (s, e) => { GameWin.ResumeAll(); Passthrough.Disable(); };
            stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            stdout.WriteLine("{\"ready\":true}");
            Pad.Start();
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                var copy = line;
                ThreadPool.QueueUserWorkItem(_ => Process(copy));
            }
            BtScan.Stop();
            Passthrough.Disable();
            GameWin.ResumeAll();
        }

        /// <summary>Unsolicited event line (no id), e.g. a controller button.</summary>
        public static void Emit(Dictionary<string, object> evt)
        {
            var text = Json.Serialize(evt);
            lock (WriteLock) stdout.WriteLine(text);
        }

        static void Process(string line)
        {
            var res = new Dictionary<string, object>();
            object id = null;
            try
            {
                var req = Json.Deserialize<Dictionary<string, object>>(line);
                if (req.ContainsKey("id")) id = req["id"];
                res["data"] = Handle(req);
                res["ok"] = true;
            }
            catch (Exception e)
            {
                var inner = e is AggregateException && e.InnerException != null ? e.InnerException : e;
                res["ok"] = false;
                res["error"] = inner.Message;
            }
            res["id"] = id;
            var text = Json.Serialize(res);
            lock (WriteLock) stdout.WriteLine(text);
        }

        static string Str(Dictionary<string, object> r, string k)
        {
            object v;
            return r.TryGetValue(k, out v) && v != null ? v.ToString() : null;
        }

        static int Int(Dictionary<string, object> r, string k, int def)
        {
            object v;
            return r.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : def;
        }

        static long Long(Dictionary<string, object> r, string k)
        {
            object v;
            return r.TryGetValue(k, out v) && v != null ? Convert.ToInt64(v) : 0;
        }

        static bool Bool(Dictionary<string, object> r, string k)
        {
            object v;
            return r.TryGetValue(k, out v) && v is bool && (bool)v;
        }

        /// <summary>
        /// Start a program through the Windows shell. Unlike spawning from Node,
        /// nothing from the launcher (pipes, sockets) is inherited by the game,
        /// and games that need administrator rights get the normal UAC prompt.
        /// </summary>
        static object Launch(string file, string args, string cwd)
        {
            var psi = new System.Diagnostics.ProcessStartInfo(file)
            {
                Arguments = args ?? "",
                UseShellExecute = true,
                WorkingDirectory = string.IsNullOrEmpty(cwd) ? System.IO.Path.GetDirectoryName(file) : cwd,
            };
            using (var p = System.Diagnostics.Process.Start(psi))
            {
                return p == null ? 0 : p.Id;
            }
        }

        static object Handle(Dictionary<string, object> req)
        {
            switch (Str(req, "cmd"))
            {
                case "ping": return "pong";
                case "media": return Media.State(Str(req, "app"), Bool(req, "art"));
                case "mediaPlaying": return Media.AnyPlaying();
                case "mediaCmd": return Media.Command(Str(req, "app"), Str(req, "action"), Int(req, "value", 0));
                case "volume": return new Dictionary<string, object> { { "volume", Audio.GetVolume() }, { "muted", Audio.GetMute() } };
                case "setVolume": Audio.SetVolume(Int(req, "value", 50)); return true;
                case "setMute": Audio.SetMute(Bool(req, "value")); return true;
                case "audioOutputs": return Audio.Outputs();
                case "setAudioOutput": return Audio.SetOutput(Str(req, "device"));
                case "brightness": return Monitors.Get();
                case "setBrightness": return Monitors.Set(Int(req, "value", 50), Int(req, "index", -1));
                case "nightLight": return NightLight.Get();
                case "setNightLight": return NightLight.Set(Bool(req, "value"));
                case "bt": return Bluetooth.State();
                case "btRadio": return Bluetooth.SetRadio(Bool(req, "value"));
                case "btConnect": return Bluetooth.SetConnection(Str(req, "address"), true);
                case "btDisconnect": return Bluetooth.SetConnection(Str(req, "address"), false);
                case "btPair": return Bluetooth.Pair(Str(req, "device"));
                case "btUnpair": return Bluetooth.Unpair(Str(req, "device"));
                case "btScanStart": return BtScan.Start();
                case "btScan": return BtScan.Results();
                case "btScanStop": BtScan.Stop(); return true;
                case "procs": return Procs.List();
                case "procPath": return Procs.ImagePath(Int(req, "pid", 0));
                case "closeWindows": return Procs.CloseWindows(Int(req, "pid", 0));
                case "fgGet": return Fg.Get();
                case "fgSet": return Fg.Set(Long(req, "hwnd"));
                case "dirWindows": return Fg.DirWindows(req.ContainsKey("dirs") ? ((System.Collections.ArrayList)req["dirs"]).Cast<object>().Select(o => Convert.ToString(o)).ToList() : new List<string>());
                case "padForward": Pad.Forward = Bool(req, "value"); return true;
                case "padInfo": return Pad.Info();
                case "passthrough":
                    if (req.ContainsKey("mode")) Passthrough.Configure(Str(req, "mode"));
                    return Passthrough.Enable(Bool(req, "value"));
                case "passthroughConfig": return Passthrough.Configure(Str(req, "mode"));
                case "passthroughMute": return Passthrough.SetMuted(Bool(req, "value"));
                case "passthroughStatus": return Passthrough.Status();
                case "captureButton": Passthrough.StripCreate = Bool(req, "value"); return true;
                case "launch": return Launch(Str(req, "file"), Str(req, "args"), Str(req, "cwd"));
                case "windowTitles": return GameWin.Titles(Int(req, "pid", 0));
                case "focusProc": return GameWin.Focus(Int(req, "pid", 0));
                case "suspend": if (Bool(req, "wait")) Pad.WaitIdle(1500); return GameWin.Suspend(Int(req, "pid", 0), true);
                case "resume": if (Bool(req, "wait")) Pad.WaitIdle(1500); return GameWin.Suspend(Int(req, "pid", 0), false);
                case "resumeAll": GameWin.ResumeAll(); return true;
                case "netConns": return Net.Established(Int(req, "pid", 0));
                case "procQos":
                    var pids = req.ContainsKey("pids") && req["pids"] is System.Collections.ArrayList ? ((System.Collections.ArrayList)req["pids"]).Cast<object>().Select(o => Convert.ToInt32(o)) : Enumerable.Empty<int>();
                    return Qos.Apply(pids, Bool(req, "eco"), Bool(req, "lower"), Bool(req, "trim"));
                default: throw new ArgumentException("unknown command");
            }
        }
    }

    static class Async
    {
        public static T Await<T>(IAsyncOperation<T> op, int timeoutMs)
        {
            using (var done = new ManualResetEvent(false))
            {
                op.Completed = (info, status) => done.Set();
                if (op.Status == AsyncStatus.Started && !done.WaitOne(timeoutMs)) throw new TimeoutException("request timed out");
                if (op.Status == AsyncStatus.Error) throw new Exception(op.ErrorCode.Message, op.ErrorCode);
                if (op.Status == AsyncStatus.Canceled) throw new OperationCanceledException();
                return op.GetResults();
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Media sessions                                                      */
    /* ------------------------------------------------------------------ */

    static class Media
    {
        static GlobalSystemMediaTransportControlsSessionManager mgr;

        static readonly object Gate = new object();

        static T Await<T>(IAsyncOperation<T> op)
        {
            return Async.Await(op, 5000);
        }

        static GlobalSystemMediaTransportControlsSessionManager Manager()
        {
            lock (Gate)
            {
                if (mgr == null) mgr = Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
                return mgr;
            }
        }

        static bool IsPlaying(GlobalSystemMediaTransportControlsSession s)
        {
            return s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        }

        /// <summary>Is another app playing media right now? (The launcher pauses its menu music meanwhile.)</summary>
        public static bool AnyPlaying()
        {
            try
            {
                foreach (var s in Manager().GetSessions())
                {
                    var id = s.SourceAppUserModelId ?? "";
                    if (id.IndexOf("electron", StringComparison.OrdinalIgnoreCase) >= 0 || id.IndexOf("PS5 Game Launcher", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                    if (IsPlaying(s)) return true;
                }
            }
            catch { }
            return false;
        }

        // The requested app if it has a session, else something that is playing
        // (preferring Windows' "current" session), else the current session.
        static GlobalSystemMediaTransportControlsSession Pick(string app)
        {
            var sessions = Manager().GetSessions().ToList();
            if (sessions.Count == 0) return null;
            if (!string.IsNullOrEmpty(app))
            {
                var hit = sessions.FirstOrDefault(s => s.SourceAppUserModelId == app);
                if (hit != null) return hit;
            }
            var cur = Manager().GetCurrentSession();
            if (cur != null && IsPlaying(cur)) return cur;
            var playing = sessions.FirstOrDefault(IsPlaying);
            if (playing != null) return playing;
            return cur ?? sessions[0];
        }

        public static object State(string app, bool withArt)
        {
            var d = new Dictionary<string, object>();
            var list = new List<object>();
            foreach (var x in Manager().GetSessions())
            {
                list.Add(new Dictionary<string, object> { { "app", x.SourceAppUserModelId }, { "status", x.GetPlaybackInfo().PlaybackStatus.ToString() } });
            }
            d["sessions"] = list;
            var s = Pick(app);
            if (s == null)
            {
                d["active"] = false;
                return d;
            }
            var p = Await(s.TryGetMediaPropertiesAsync());
            var pb = s.GetPlaybackInfo();
            var tl = s.GetTimelineProperties();
            d["active"] = true;
            d["app"] = s.SourceAppUserModelId;
            d["title"] = p.Title;
            d["artist"] = string.IsNullOrEmpty(p.Artist) ? p.AlbumArtist : p.Artist;
            d["album"] = p.AlbumTitle;
            d["status"] = pb.PlaybackStatus.ToString();
            d["canPrev"] = pb.Controls.IsPreviousEnabled;
            d["canNext"] = pb.Controls.IsNextEnabled;
            d["canToggle"] = pb.Controls.IsPlayPauseToggleEnabled;
            d["canSeek"] = pb.Controls.IsPlaybackPositionEnabled;
            d["position"] = tl.Position.TotalSeconds;
            d["duration"] = (tl.EndTime - tl.StartTime).TotalSeconds;
            d["updated"] = tl.LastUpdatedTime.ToUnixTimeMilliseconds();
            d["key"] = p.Title + "|" + p.Artist + "|" + p.AlbumTitle;
            if (withArt && p.Thumbnail != null)
            {
                try
                {
                    var st = Await(p.Thumbnail.OpenReadAsync());
                    using (var reader = new Windows.Storage.Streams.DataReader(st))
                    {
                        var n = Await(reader.LoadAsync((uint)st.Size));
                        var bytes = new byte[n];
                        reader.ReadBytes(bytes);
                        var type = string.IsNullOrEmpty(st.ContentType) ? "image/png" : st.ContentType;
                        d["art"] = "data:" + type + ";base64," + Convert.ToBase64String(bytes);
                    }
                    st.Dispose();
                }
                catch { }
            }
            return d;
        }

        public static bool Command(string app, string action, int value)
        {
            var s = Pick(app);
            if (s == null) return false;
            switch (action)
            {
                case "toggle": return Await(s.TryTogglePlayPauseAsync());
                case "play": return Await(s.TryPlayAsync());
                case "pause": return Await(s.TryPauseAsync());
                case "next": return Await(s.TrySkipNextAsync());
                case "prev": return Await(s.TrySkipPreviousAsync());
                case "seek": return Await(s.TryChangePlaybackPositionAsync((long)value * 10000000L));
            }
            return false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* System volume (Core Audio)                                          */
    /* ------------------------------------------------------------------ */

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr p);
        int UnregisterControlChangeNotify(IntPtr p);
        int GetChannelCount(out uint c);
        int SetMasterVolumeLevel(float l, ref Guid ctx);
        int SetMasterVolumeLevelScalar(float l, ref Guid ctx);
        int GetMasterVolumeLevel(out float l);
        int GetMasterVolumeLevelScalar(out float l);
        int SetChannelVolumeLevel(uint ch, float l, ref Guid ctx);
        int SetChannelVolumeLevelScalar(uint ch, float l, ref Guid ctx);
        int GetChannelVolumeLevel(uint ch, out float l);
        int GetChannelVolumeLevelScalar(uint ch, out float l);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr store);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        int GetCount(out uint count);
        int Item(uint index, out IMMDevice device);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    }

    [Guid("2A07407E-6497-4A18-9787-32F79BD0D98F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDeviceTopology
    {
        int GetConnectorCount(out uint count);
        int GetConnector(uint index, out IConnector connector);
    }

    [Guid("9C2C4058-23F5-41DE-877A-DF3AF236A09E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IConnector
    {
        int GetType(out int type);
        int GetDataFlow(out int flow);
        int ConnectTo(IConnector other);
        int Disconnect();
        int IsConnected([MarshalAs(UnmanagedType.Bool)] out bool connected);
        int GetConnectedTo(out IConnector other);
        int GetConnectorIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetDeviceIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KSPROPERTY
    {
        public Guid Set;
        public uint Id;
        public uint Flags;
    }

    [Guid("28F54685-06FD-11D2-B27A-00A0C9223196"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IKsControl
    {
        [PreserveSig] int KsProperty(ref KSPROPERTY prop, uint propLen, IntPtr data, uint dataLen, out uint returned);
        [PreserveSig] int KsMethod(IntPtr method, uint methodLen, IntPtr data, uint dataLen, out uint returned);
        [PreserveSig] int KsEvent(IntPtr evt, uint evtLen, IntPtr data, uint dataLen, out uint returned);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY
    {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT
    {
        public ushort vt;
        public ushort r1, r2, r3;
        public IntPtr p;
        public IntPtr p2;
    }

    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        int GetCount(out uint count);
        int GetAt(uint index, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        int Commit();
    }

    // Not in the SDK, but stable since Windows 7: the interface Windows' own
    // Sound settings use to change the default playback device. Only
    // SetDefaultEndpoint is called; the slots before it keep the vtable order.
    [Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        int GetMixFormat(IntPtr a, IntPtr b);
        int GetDeviceFormat(IntPtr a, int b, IntPtr c);
        int ResetDeviceFormat(IntPtr a);
        int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
        int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
        int SetProcessingPeriod(IntPtr a, IntPtr b);
        int GetShareMode(IntPtr a, IntPtr b);
        int SetShareMode(IntPtr a, IntPtr b);
        int GetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
        int SetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
        int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
        int SetEndpointVisibility(IntPtr a, int b);
    }

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    class PolicyConfigClient { }

    static class Audio
    {
        static IAudioEndpointVolume Endpoint()
        {
            var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDevice dev;
            Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
            var iid = typeof(IAudioEndpointVolume).GUID;
            object o;
            Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
            return (IAudioEndpointVolume)o;
        }

        public static int GetVolume()
        {
            float v;
            Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v));
            return (int)Math.Round(v * 100);
        }

        public static void SetVolume(int percent)
        {
            var g = Guid.Empty;
            Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, percent)) / 100f, ref g));
        }

        public static bool GetMute()
        {
            bool m;
            Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m));
            return m;
        }

        public static void SetMute(bool mute)
        {
            var g = Guid.Empty;
            Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute, ref g));
        }

        static readonly Guid PkeyDevice = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");
        static readonly Guid PkeyInterface = new Guid("026E516E-B814-414B-83CD-856D6FEF4822");

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PROPVARIANT pv);

        static string Prop(IPropertyStore store, Guid fmtid, int pid)
        {
            var key = new PROPERTYKEY { fmtid = fmtid, pid = pid };
            PROPVARIANT v;
            if (store.GetValue(ref key, out v) != 0) return null;
            try
            {
                return v.vt == 31 /* VT_LPWSTR */ ? Marshal.PtrToStringUni(v.p) : null;
            }
            finally
            {
                PropVariantClear(ref v);
            }
        }

        /// <summary>Active playback devices, e.g. "Speakers (Realtek(R) Audio)".</summary>
        public static List<Dictionary<string, object>> Outputs()
        {
            var list = new List<Dictionary<string, object>>();
            var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            string def = null;
            IMMDevice d;
            if (en.GetDefaultAudioEndpoint(0, 1, out d) == 0) d.GetId(out def);
            IMMDeviceCollection col;
            Marshal.ThrowExceptionForHR(en.EnumAudioEndpoints(0 /* render */, 1 /* active */, out col));
            uint count;
            col.GetCount(out count);
            for (uint i = 0; i < count; i++)
            {
                try
                {
                    IMMDevice dev;
                    if (col.Item(i, out dev) != 0) continue;
                    string id;
                    dev.GetId(out id);
                    string name = null, desc = null, adapter = null;
                    IntPtr ps;
                    if (dev.OpenPropertyStore(0 /* read */, out ps) == 0 && ps != IntPtr.Zero)
                    {
                        try
                        {
                            var store = (IPropertyStore)Marshal.GetObjectForIUnknown(ps);
                            name = Prop(store, PkeyDevice, 14); // Device_FriendlyName
                            desc = Prop(store, PkeyDevice, 2); // Device_DeviceDesc
                            adapter = Prop(store, PkeyInterface, 2); // DeviceInterface_FriendlyName
                        }
                        finally
                        {
                            Marshal.Release(ps);
                        }
                    }
                    list.Add(new Dictionary<string, object>
                    {
                        { "id", id },
                        { "name", name ?? desc ?? id },
                        { "desc", desc ?? "" },
                        { "adapter", adapter ?? "" },
                        { "default", id == def },
                    });
                }
                catch { }
            }
            return list;
        }

        /// <summary>Make a device the default for every role (console, multimedia, communications).</summary>
        public static bool SetOutput(string id)
        {
            if (string.IsNullOrEmpty(id)) throw new ArgumentException("id required");
            var pc = (IPolicyConfig)new PolicyConfigClient();
            for (int role = 0; role < 3; role++) Marshal.ThrowExceptionForHR(pc.SetDefaultEndpoint(id, role));
            return true;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Monitor brightness (DDC/CI + WMI fallback)                          */
    /* ------------------------------------------------------------------ */

    static class Monitors
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PHYSICAL_MONITOR
        {
            public IntPtr hPhysicalMonitor;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription;
        }

        delegate bool EnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);

        [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumProc proc, IntPtr data);
        [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);
        [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint count, [Out] PHYSICAL_MONITOR[] monitors);
        [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint count, PHYSICAL_MONITOR[] monitors);
        [DllImport("dxva2.dll")] static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte code, out uint type, out uint current, out uint max);
        [DllImport("dxva2.dll")] static extern bool SetVCPFeature(IntPtr h, byte code, uint value);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct MONITORINFOEX
        {
            public int cbSize;
            public int l, t, r, b, wl, wt, wr, wb;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
        [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
        [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathArray, ref uint modes, IntPtr modeArray, IntPtr topology);
        [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(IntPtr packet);

        /// <summary>
        /// GDI device name (DISPLAY1, DISPLAY2, ...) -> the monitor's own name from its
        /// EDID ("PL2730H"), the name Windows shows in Display settings.
        /// </summary>
        static Dictionary<string, string> FriendlyNames()
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            const int PathSize = 72, ModeSize = 64;
            uint np, nm;
            if (GetDisplayConfigBufferSizes(2 /* QDC_ONLY_ACTIVE_PATHS */, out np, out nm) != 0 || np == 0) return map;
            IntPtr paths = Marshal.AllocHGlobal((int)np * PathSize), modes = Marshal.AllocHGlobal((int)nm * ModeSize);
            IntPtr src = Marshal.AllocHGlobal(84), tgt = Marshal.AllocHGlobal(420);
            try
            {
                if (QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return map;
                for (int i = 0; i < np; i++)
                {
                    IntPtr p = paths + i * PathSize;
                    // Source: adapter LUID at +0, id at +8. Target: LUID at +20, id at +28.
                    Header(src, 1 /* GET_SOURCE_NAME */, 84, p, 0);
                    Header(tgt, 2 /* GET_TARGET_NAME */, 420, p, 20);
                    if (DisplayConfigGetDeviceInfo(src) != 0 || DisplayConfigGetDeviceInfo(tgt) != 0) continue;
                    var gdi = Marshal.PtrToStringUni(src + 20);
                    var name = Marshal.PtrToStringUni(tgt + 36);
                    if (!string.IsNullOrEmpty(gdi) && !string.IsNullOrEmpty(name)) map[gdi] = name;
                }
            }
            catch { }
            finally
            {
                Marshal.FreeHGlobal(paths);
                Marshal.FreeHGlobal(modes);
                Marshal.FreeHGlobal(src);
                Marshal.FreeHGlobal(tgt);
            }
            return map;
        }

        static void Header(IntPtr packet, int type, int size, IntPtr path, int offset)
        {
            for (int i = 0; i < size; i += 4) Marshal.WriteInt32(packet, i, 0);
            Marshal.WriteInt32(packet, 0, type);
            Marshal.WriteInt32(packet, 4, size);
            Marshal.WriteInt64(packet, 8, Marshal.ReadInt64(path, offset));
            Marshal.WriteInt32(packet, 16, Marshal.ReadInt32(path, offset + 8));
        }

        class Group
        {
            public string Name;
            public PHYSICAL_MONITOR[] Monitors;
        }

        static List<Group> Open()
        {
            var handles = new List<IntPtr>();
            EnumProc cb = (h, dc, r, d) => { handles.Add(h); return true; };
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            var names = FriendlyNames();
            var result = new List<Group>();
            foreach (var h in handles)
            {
                uint n;
                if (!GetNumberOfPhysicalMonitorsFromHMONITOR(h, out n) || n == 0) continue;
                var arr = new PHYSICAL_MONITOR[n];
                if (!GetPhysicalMonitorsFromHMONITOR(h, n, arr)) continue;
                var info = new MONITORINFOEX { cbSize = Marshal.SizeOf(typeof(MONITORINFOEX)) };
                string name = null;
                if (GetMonitorInfo(h, ref info) && info.szDevice != null) names.TryGetValue(info.szDevice, out name);
                result.Add(new Group { Name = name, Monitors = arr });
            }
            return result;
        }

        public static List<object> Get()
        {
            var list = new List<object>();
            foreach (var g in Open())
            {
                var arr = g.Monitors;
                foreach (var m in arr)
                {
                    uint type, cur, max;
                    if (GetVCPFeatureAndVCPFeatureReply(m.hPhysicalMonitor, 0x10, out type, out cur, out max) && max > 0)
                    {
                        var desc = m.szPhysicalMonitorDescription;
                        var generic = string.IsNullOrEmpty(desc) || desc.IndexOf("Generic", StringComparison.OrdinalIgnoreCase) >= 0;
                        list.Add(new Dictionary<string, object> {
                            { "name", arr.Length == 1 && !string.IsNullOrEmpty(g.Name) ? g.Name : generic ? (g.Name ?? "") : desc },
                            { "percent", (int)Math.Round(cur * 100.0 / max) },
                            { "method", "ddc" },
                        });
                    }
                }
                DestroyPhysicalMonitors((uint)arr.Length, arr);
            }
            if (list.Count == 0)
            {
                try
                {
                    using (var q = new ManagementObjectSearcher("root\\WMI", "SELECT CurrentBrightness FROM WmiMonitorBrightness"))
                    {
                        foreach (ManagementObject o in q.Get())
                        {
                            list.Add(new Dictionary<string, object> {
                                { "name", "Built-in display" },
                                { "percent", Convert.ToInt32(o["CurrentBrightness"]) },
                                { "method", "wmi" },
                            });
                            break;
                        }
                    }
                }
                catch { }
            }
            return list;
        }

        public static int Set(int percent, int index)
        {
            percent = Math.Max(0, Math.Min(100, percent));
            int ok = 0, i = -1;
            foreach (var g in Open())
            {
                var arr = g.Monitors;
                foreach (var m in arr)
                {
                    uint type, cur, max;
                    if (!GetVCPFeatureAndVCPFeatureReply(m.hPhysicalMonitor, 0x10, out type, out cur, out max) || max == 0) continue;
                    i++;
                    if (index >= 0 && index != i) continue;
                    var v = (uint)Math.Round(percent * max / 100.0);
                    if (v == cur || SetVCPFeature(m.hPhysicalMonitor, 0x10, v)) ok++;
                }
                DestroyPhysicalMonitors((uint)arr.Length, arr);
            }
            if (ok == 0)
            {
                try
                {
                    using (var q = new ManagementObjectSearcher("root\\WMI", "SELECT * FROM WmiMonitorBrightnessMethods"))
                    {
                        foreach (ManagementObject o in q.Get())
                        {
                            o.InvokeMethod("WmiSetBrightness", new object[] { (uint)1, (byte)percent });
                            ok = 1;
                            break;
                        }
                    }
                }
                catch { }
            }
            return ok;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Bluetooth                                                           */
    /* ------------------------------------------------------------------ */

    static class Bluetooth
    {
        const string ProtoClassic = "{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}";
        const string ProtoLe = "{bb7bb05e-5972-42b5-94fc-76eaa7084d49}";
        static readonly Guid KsPropSetBtAudio = new Guid("7FA06C40-B8F6-4C7E-8556-E8C33A12E54D");

        public static readonly string[] Props =
        {
            "System.Devices.Aep.DeviceAddress",
            "System.Devices.Aep.IsConnected",
            "System.Devices.Aep.IsPaired",
            "System.Devices.Aep.Bluetooth.Cod.Major",
            "System.Devices.Aep.Bluetooth.Cod.Minor",
            "System.Devices.Aep.ProtocolId",
            "System.Devices.Aep.SignalStrength",
        };

        public static string Aqs(bool paired)
        {
            return "(System.Devices.Aep.ProtocolId:=\"" + ProtoClassic + "\" OR System.Devices.Aep.ProtocolId:=\"" + ProtoLe +
                   "\") AND System.Devices.Aep.IsPaired:=System.StructuredQueryType.Boolean#" + (paired ? "True" : "False");
        }

        static Radio FindRadio()
        {
            Async.Await(Radio.RequestAccessAsync(), 5000);
            var radios = Async.Await(Radio.GetRadiosAsync(), 5000);
            return radios.FirstOrDefault(r => r.Kind == RadioKind.Bluetooth);
        }

        static object Prop(DeviceInformation i, string key)
        {
            object v;
            return i.Properties.TryGetValue(key, out v) ? v : null;
        }

        public static string Norm(string address)
        {
            return (address ?? "").Replace(":", "").Replace("-", "").ToLowerInvariant();
        }

        static string Kind(string name, int major, int minor)
        {
            var n = (name ?? "").ToLowerInvariant();
            if (n.Contains("controller") || n.Contains("dualsense") || n.Contains("dualshock") || n.Contains("xbox") || n.Contains("gamepad") || n.Contains("joy-con")) return "gamepad";
            if (major == 4 || n.Contains("headphone") || n.Contains("headset") || n.Contains("speaker") || n.Contains("buds") || n.Contains("airpods") || n.Contains("jbl") || n.Contains("soundbar")) return "audio";
            if (major == 5)
            {
                if ((minor & 0x0F) == 1 || (minor & 0x0F) == 2) return "gamepad";
                if ((minor & 0x30) == 0x10) return "keyboard";
                if ((minor & 0x30) == 0x20) return "mouse";
                return "input";
            }
            if (n.Contains("keyboard")) return "keyboard";
            if (n.Contains("mouse")) return "mouse";
            if (major == 2 || n.Contains("phone")) return "phone";
            if (major == 1) return "computer";
            return "other";
        }

        public static Dictionary<string, object> Describe(DeviceInformation i, HashSet<string> audio)
        {
            var addr = Convert.ToString(Prop(i, "System.Devices.Aep.DeviceAddress") ?? "");
            var connected = Prop(i, "System.Devices.Aep.IsConnected") as bool? ?? false;
            var major = Convert.ToInt32(Prop(i, "System.Devices.Aep.Bluetooth.Cod.Major") ?? 0);
            var minor = Convert.ToInt32(Prop(i, "System.Devices.Aep.Bluetooth.Cod.Minor") ?? 0);
            var proto = Convert.ToString(Prop(i, "System.Devices.Aep.ProtocolId") ?? "").ToLowerInvariant();
            var signal = Prop(i, "System.Devices.Aep.SignalStrength");
            return new Dictionary<string, object>
            {
                { "id", i.Id },
                { "name", i.Name },
                { "address", addr },
                { "connected", connected },
                { "le", proto.Contains("bb7bb05e") },
                { "kind", Kind(i.Name, major, minor) },
                { "audio", audio != null && audio.Contains(Norm(addr)) },
                { "signal", signal == null ? null : (object)Convert.ToInt32(signal) },
            };
        }

        static string Hex(ulong address)
        {
            return address.ToString("x12");
        }

        static string Colons(string hex)
        {
            var parts = new List<string>();
            for (var i = 0; i + 1 < hex.Length; i += 2) parts.Add(hex.Substring(i, 2));
            return string.Join(":", parts);
        }

        static string Kind(string name, Windows.Devices.Bluetooth.BluetoothMajorClass major, int minor)
        {
            return Kind(name, (int)major, minor);
        }

        public static object State()
        {
            var d = new Dictionary<string, object>();
            Radio radio = null;
            try { radio = FindRadio(); } catch { }
            d["available"] = radio != null;
            d["on"] = radio != null && radio.State == RadioState.On;
            d["radio"] = radio != null ? radio.State.ToString() : "None";
            var list = new List<object>();
            if (radio != null)
            {
                HashSet<string> audio;
                try { audio = new HashSet<string>(AudioFilters().Select(f => f["address"] as string).Where(a => !string.IsNullOrEmpty(a))); }
                catch { audio = new HashSet<string>(); }
                var names = new HashSet<string>();

                // Classic Bluetooth (speakers, headsets, controllers, keyboards…)
                var classic = Async.Await(DeviceInformation.FindAllAsync(Windows.Devices.Bluetooth.BluetoothDevice.GetDeviceSelectorFromPairingState(true)), 8000);
                foreach (var info in classic)
                {
                    try
                    {
                        var dev = Async.Await(Windows.Devices.Bluetooth.BluetoothDevice.FromIdAsync(info.Id), 5000);
                        if (dev == null || string.IsNullOrWhiteSpace(dev.Name)) continue;
                        var hex = Hex(dev.BluetoothAddress);
                        names.Add(dev.Name);
                        list.Add(new Dictionary<string, object>
                        {
                            { "id", info.Id },
                            { "name", dev.Name },
                            { "address", Colons(hex) },
                            { "connected", dev.ConnectionStatus == Windows.Devices.Bluetooth.BluetoothConnectionStatus.Connected },
                            { "le", false },
                            { "kind", Kind(dev.Name, dev.ClassOfDevice.MajorClass, (int)dev.ClassOfDevice.RawValue >> 2 & 0x3F) },
                            { "audio", audio.Contains(hex) },
                        });
                        dev.Dispose();
                    }
                    catch { }
                }

                // Bluetooth LE (mice, keyboards, some headphones)
                try
                {
                    var le = Async.Await(DeviceInformation.FindAllAsync(Windows.Devices.Bluetooth.BluetoothLEDevice.GetDeviceSelectorFromPairingState(true)), 8000);
                    foreach (var info in le)
                    {
                        try
                        {
                            var dev = Async.Await(Windows.Devices.Bluetooth.BluetoothLEDevice.FromIdAsync(info.Id), 5000);
                            if (dev == null || string.IsNullOrWhiteSpace(dev.Name) || names.Contains(dev.Name)) continue;
                            var hex = Hex(dev.BluetoothAddress);
                            list.Add(new Dictionary<string, object>
                            {
                                { "id", info.Id },
                                { "name", dev.Name },
                                { "address", Colons(hex) },
                                { "connected", dev.ConnectionStatus == Windows.Devices.Bluetooth.BluetoothConnectionStatus.Connected },
                                { "le", true },
                                { "kind", Kind(dev.Name, 0, 0) },
                                { "audio", audio.Contains(hex) },
                            });
                            dev.Dispose();
                        }
                        catch { }
                    }
                }
                catch { }
            }
            d["devices"] = list;
            return d;
        }

        public static object SetRadio(bool on)
        {
            var radio = FindRadio();
            if (radio == null) throw new InvalidOperationException("No Bluetooth adapter found");
            return Async.Await(radio.SetStateAsync(on ? RadioState.On : RadioState.Off), 15000).ToString();
        }

        static DeviceInformation Info(string id)
        {
            return Async.Await(DeviceInformation.CreateFromIdAsync(id, Props, DeviceInformationKind.AssociationEndpoint), 10000);
        }

        public static object Pair(string id)
        {
            var info = Info(id);
            if (info.Pairing.IsPaired) return "AlreadyPaired";
            var custom = info.Pairing.Custom;
            TypedEventHandler<DeviceInformationCustomPairing, DevicePairingRequestedEventArgs> handler = (sender, args) =>
            {
                if (args.PairingKind == DevicePairingKinds.ProvidePin) args.Accept("0000");
                else args.Accept();
            };
            custom.PairingRequested += handler;
            try
            {
                var kinds = DevicePairingKinds.ConfirmOnly | DevicePairingKinds.DisplayPin | DevicePairingKinds.ProvidePin | DevicePairingKinds.ConfirmPinMatch;
                return Async.Await(custom.PairAsync(kinds), 60000).Status.ToString();
            }
            finally
            {
                custom.PairingRequested -= handler;
            }
        }

        public static object Unpair(string id)
        {
            DeviceInformation info = null;
            try
            {
                var dev = Async.Await(Windows.Devices.Bluetooth.BluetoothDevice.FromIdAsync(id), 5000);
                if (dev != null) info = dev.DeviceInformation;
            }
            catch { }
            if (info == null)
            {
                try
                {
                    var le = Async.Await(Windows.Devices.Bluetooth.BluetoothLEDevice.FromIdAsync(id), 5000);
                    if (le != null) info = le.DeviceInformation;
                }
                catch { }
            }
            if (info == null) info = Info(id);
            return Async.Await(info.Pairing.UnpairAsync(), 30000).Status.ToString();
        }

        // Bluetooth audio endpoints and the KS filter behind each one. The filter's
        // device path contains the Bluetooth address of the speaker/headset.
        public static List<Dictionary<string, object>> AudioFilters()
        {
            var result = new List<Dictionary<string, object>>();
            var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDeviceCollection col;
            if (en.EnumAudioEndpoints(2, 0x1 | 0x4 | 0x8, out col) != 0) return result;
            uint count;
            col.GetCount(out count);
            var seen = new HashSet<string>();
            for (uint i = 0; i < count; i++)
            {
                try
                {
                    IMMDevice dev;
                    if (col.Item(i, out dev) != 0) continue;
                    var iid = typeof(IDeviceTopology).GUID;
                    object o;
                    if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
                    var topo = (IDeviceTopology)o;
                    IConnector conn;
                    if (topo.GetConnector(0, out conn) != 0) continue;
                    string ksId;
                    if (conn.GetDeviceIdConnectedTo(out ksId) != 0 || string.IsNullOrEmpty(ksId)) continue;
                    var low = ksId.ToLowerInvariant();
                    if (!low.Contains("bth") || !seen.Add(low)) continue;
                    var m = System.Text.RegularExpressions.Regex.Match(low, "[#&_]([0-9a-f]{12})(?:_|#|&|$)");
                    int state;
                    dev.GetState(out state);
                    result.Add(new Dictionary<string, object> { { "ks", ksId }, { "address", m.Success ? m.Groups[1].Value : "" }, { "state", state } });
                }
                catch { }
            }
            return result;
        }

        public static int SetConnection(string address, bool connect)
        {
            var key = Norm(address);
            if (key.Length == 0) throw new ArgumentException("address required");
            var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            int sent = 0;
            foreach (var f in AudioFilters())
            {
                if ((string)f["address"] != key) continue;
                IMMDevice ks;
                if (en.GetDevice((string)f["ks"], out ks) != 0) continue;
                var iid = typeof(IKsControl).GUID;
                object o;
                if (ks.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
                var ctl = (IKsControl)o;
                var prop = new KSPROPERTY { Set = KsPropSetBtAudio, Id = connect ? 0u : 1u, Flags = 1 /* KSPROPERTY_TYPE_GET */ };
                uint ret;
                if (ctl.KsProperty(ref prop, (uint)Marshal.SizeOf(typeof(KSPROPERTY)), IntPtr.Zero, 0, out ret) >= 0) sent++;
            }
            if (sent == 0) throw new InvalidOperationException(connect ? "This device can't be connected from the PC. Turn it on to connect it." : "This device can't be disconnected from the PC.");
            return sent;
        }
    }

    static class BtScan
    {
        static readonly object Gate = new object();
        static DeviceWatcher watcher;
        static readonly Dictionary<string, Dictionary<string, object>> Found = new Dictionary<string, Dictionary<string, object>>();
        static DateTime started;

        public static object Start()
        {
            lock (Gate)
            {
                StopLocked();
                Found.Clear();
                started = DateTime.UtcNow;
                var w = DeviceInformation.CreateWatcher(Bluetooth.Aqs(false), Bluetooth.Props, DeviceInformationKind.AssociationEndpoint);
                w.Added += (s, info) =>
                {
                    if (string.IsNullOrWhiteSpace(info.Name)) return;
                    lock (Gate) Found[info.Id] = Bluetooth.Describe(info, null);
                };
                w.Removed += (s, upd) =>
                {
                    lock (Gate) Found.Remove(upd.Id);
                };
                w.Updated += (s, upd) => { };
                w.Start();
                watcher = w;
            }
            return true;
        }

        public static object Results()
        {
            lock (Gate)
            {
                // Scanning is bounded so it never runs forever in the background.
                if (watcher != null && (DateTime.UtcNow - started).TotalSeconds > 90) StopLocked();
                var active = watcher != null && (watcher.Status == DeviceWatcherStatus.Started || watcher.Status == DeviceWatcherStatus.EnumerationCompleted);
                return new Dictionary<string, object>
                {
                    { "scanning", active },
                    { "devices", Found.Values.OrderBy(d => (string)d["name"]).Cast<object>().ToList() },
                };
            }
        }

        public static void Stop()
        {
            lock (Gate) StopLocked();
        }

        static void StopLocked()
        {
            if (watcher == null) return;
            try
            {
                if (watcher.Status == DeviceWatcherStatus.Started || watcher.Status == DeviceWatcherStatus.EnumerationCompleted) watcher.Stop();
            }
            catch { }
            watcher = null;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Night Light                                                         */
    /* ------------------------------------------------------------------ */

    // Windows keeps the Night Light switch in a CloudStore blob. Byte 18 is the
    // payload size: 0x15 when the "enabled" field (0x10 0x00) is present.
    static class NightLight
    {
        const string KeyPath = @"Software\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\default$windows.data.bluelightreduction.bluelightreductionstate\windows.data.bluelightreduction.bluelightreductionstate";

        public static object Get()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(KeyPath))
            {
                var data = k == null ? null : k.GetValue("Data") as byte[];
                return new Dictionary<string, object>
                {
                    { "available", data != null && data.Length > 24 },
                    { "on", data != null && data.Length > 24 && data[18] == 0x15 },
                };
            }
        }

        public static object Set(bool on)
        {
            using (var k = Registry.CurrentUser.OpenSubKey(KeyPath, true))
            {
                if (k == null) throw new InvalidOperationException("Night light is not available on this PC");
                var data = k.GetValue("Data") as byte[];
                if (data == null || data.Length < 25) throw new InvalidOperationException("Night light is not available on this PC");
                var isOn = data[18] == 0x15;
                if (isOn == on) return true;
                var list = data.Take(23).ToList();
                if (on)
                {
                    list.Add(0x10);
                    list.Add(0x00);
                    list.AddRange(data.Skip(23));
                    list[18] = 0x15;
                }
                else
                {
                    list.AddRange(data.Skip(25));
                    list[18] = 0x13;
                }
                // Bump the change timestamp (a varint) so Windows applies it.
                for (var i = 10; i < 15; i++)
                {
                    if ((list[i] & 0x7F) != 0x7F)
                    {
                        list[i]++;
                        break;
                    }
                }
                k.SetValue("Data", list.ToArray(), RegistryValueKind.Binary);
            }
            return true;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Controller input (for the in-game overlay)                          */
    /* ------------------------------------------------------------------ */

    // Reads controllers passively, independent of window focus:
    //  * Xbox / XInput pads through XInputGetStateEx (includes the Guide button)
    //  * DualSense / DualShock 4 through their HID input reports
    // The Guide/PS button is always reported. Other buttons are only reported
    // while the overlay is open (Forward = true).
    /* ------------------------------------------------------------------ */
    /* Controller passthrough (HidHide + VIIPER)                           */
    /* ------------------------------------------------------------------ */

    /// <summary>
    /// Games never see the real PlayStation controller: HidHide hides it from
    /// every program except this helper, and a virtual DualSense made by VIIPER
    /// (usbip-win2) takes its place. The helper forwards the real controller's
    /// input to the virtual one and the game's rumble / lightbar back. While a
    /// menu is open the virtual controller gets a "nothing pressed" state, so
    /// the game can't react to the menu's button presses.
    /// HidHide's session list is cleared by Windows when this process exits.
    /// </summary>
    static class Passthrough
    {
        public static volatile bool Enabled;
        public static volatile bool Muted;
        /// <summary>Keep the Create button from games (it opens the launcher's capture menu).</summary>
        public static volatile bool StripCreate;
        static readonly object Gate = new object();
        static readonly Dictionary<string, Virtual> Pads = new Dictionary<string, Virtual>();
        static readonly HashSet<string> Hidden = new HashSet<string>();
        static string hidhide = "unknown"; // ok | missing | denied | error
        static string viiper = "unknown"; // ok | missing | error
        static string lastError = null;
        static bool restoreInactive;
        static bool inverse;
        static List<string> allowed = new List<string>(); // other programs HidHide lets see hidden controllers
        static int busId = -1;

        /* ---------------- HidHide ---------------- */

        [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32", SetLastError = true)]
        static extern bool DeviceIoControl(Microsoft.Win32.SafeHandles.SafeFileHandle h, uint code, byte[] inBuf, int inLen, byte[] outBuf, int outLen, out int returned, IntPtr overlapped);
        [DllImport("kernel32", CharSet = CharSet.Unicode)]
        static extern uint QueryDosDevice(string device, StringBuilder target, int max);

        static uint Ioctl(int fn) { return (32769u << 16) | (1u << 14) | ((uint)fn << 2); }
        const int GET_WHITELIST = 2048, SET_WHITELIST = 2049, GET_BLACKLIST = 2050, SET_BLACKLIST = 2051, GET_ACTIVE = 2052, SET_ACTIVE = 2053, GET_WLINVERSE = 2054, ADD_SESSION = 2056, CLR_SESSION = 2057;
        static Microsoft.Win32.SafeHandles.SafeFileHandle control;

        static bool OpenHidHide()
        {
            if (control != null && !control.IsInvalid) return true;
            control = CreateFile("\\\\.\\HidHide", 0x80000000, 0x1 | 0x2 | 0x4, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (!control.IsInvalid) return true;
            var err = Marshal.GetLastWin32Error();
            hidhide = err == 5 ? "denied" : err == 2 ? "missing" : "error";
            control = null;
            return false;
        }

/// <summary>Send a request; input may be null (requests without data).</summary>
        static void Put(int fn, byte[] input)
        {
            int got;
            if (!DeviceIoControl(control, Ioctl(fn), input, input == null ? 0 : input.Length, null, 0, out got, IntPtr.Zero)) throw Fail(fn);
        }

        /// <summary>An on/off value: HidHide wants a buffer of exactly one byte.</summary>
        static bool GetFlag(int fn)
        {
            int got;
            var b = new byte[1];
            if (!DeviceIoControl(control, Ioctl(fn), null, 0, b, 1, out got, IntPtr.Zero)) throw Fail(fn);
            return b[0] != 0;
        }

        /// <summary>A string list: ask for the size first, then read it.</summary>
        static byte[] GetList(int fn)
        {
            int got;
            if (!DeviceIoControl(control, Ioctl(fn), null, 0, null, 0, out got, IntPtr.Zero)) throw Fail(fn);
            if (got <= 0) return new byte[0];
            var buf = new byte[got];
            if (!DeviceIoControl(control, Ioctl(fn), null, 0, buf, buf.Length, out got, IntPtr.Zero)) throw Fail(fn);
            return buf.Take(got).ToArray();
        }

        static Exception Fail(int fn)
        {
            var e = new System.ComponentModel.Win32Exception();
            return new System.ComponentModel.Win32Exception(e.NativeErrorCode, "HidHide " + fn + ": " + e.Message);
        }

        static List<string> FromMulti(byte[] b)
        {
            if (b == null || b.Length < 2) return new List<string>();
            return Encoding.Unicode.GetString(b).Split('\0').Where(s => s.Length > 0).ToList();
        }

        static byte[] ToMulti(IEnumerable<string> list)
        {
            return Encoding.Unicode.GetBytes(string.Join("\0", list) + "\0\0");
        }

        /// <summary>"C:\x\y.exe" -> "\Device\HarddiskVolume3\x\y.exe", the form HidHide keeps.</summary>
        static string FullImageName(string path)
        {
            var sb = new StringBuilder(1024);
            if (path.Length < 2 || QueryDosDevice(path.Substring(0, 2), sb, sb.Capacity) == 0) return null;
            return sb.ToString() + path.Substring(2);
        }

        static bool SetupHidHide()
        {
            if (!OpenHidHide()) return false;
            try
            {
                inverse = GetFlag(GET_WLINVERSE);
                var me = FullImageName(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName);
                var wl = FromMulti(GetList(GET_WHITELIST));
                // Anything else on the list (Steam, for example) still reads the real controller.
                allowed = wl.Where(x => !string.Equals(x, me, StringComparison.OrdinalIgnoreCase) && !x.EndsWith("\\syshelper.exe", StringComparison.OrdinalIgnoreCase))
                    .Select(x => x.Substring(x.LastIndexOf('\\') + 1)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                if (me != null && !inverse)
                {
                    if (!wl.Any(x => string.Equals(x, me, StringComparison.OrdinalIgnoreCase)))
                    {
                        wl.Add(me);
                        Put(SET_WHITELIST, ToMulti(wl));
                    }
                }
                if (!GetFlag(GET_ACTIVE))
                {
                    Put(SET_ACTIVE, new byte[] { 1 });
                    restoreInactive = true;
                }
                hidhide = "ok";
                return true;
            }
            catch (Exception e)
            {
                hidhide = e is System.ComponentModel.Win32Exception && ((System.ComponentModel.Win32Exception)e).NativeErrorCode == 5 ? "denied" : "error";
                lastError = e.Message;
                return false;
            }
        }

        static void Hide(string devicePath)
        {
            if (hidhide != "ok") return;
            var inst = Pad.InstancePath(devicePath);
            lock (Gate)
            {
                if (!Hidden.Add(inst)) return;
            }
            // HidHide releases up to 1.5 don't have the session list (2056); use the
            // normal device list there and remember what we added, so it can be undone.
            if (!sessionUnsupported)
            {
                try { Put(ADD_SESSION, ToMulti(new[] { inst })); }
                catch { sessionUnsupported = true; }
            }
            if (sessionUnsupported)
            {
                try { AddToBlacklist(inst); } catch (Exception e) { lastError = e.Message; return; }
            }
            // Hiding only stops new opens: games (and Steam) that already have the
            // controller keep reading it. Restarting the device closes those handles,
            // like a replug, so from then on they only find the virtual one.
            new Thread(() => { Thread.Sleep(100); RestartDevice(inst); }) { IsBackground = true, Name = "pad-restart" }.Start();
        }

        static bool sessionUnsupported;

        /// <summary>Devices we put on HidHide's (permanent) list, so a crash can't leave them hidden.</summary>
        static string RecordFile
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PS5 Game Launcher", "hidhide-hidden.txt"); }
        }

        static List<string> Recorded()
        {
            try { return File.Exists(RecordFile) ? File.ReadAllLines(RecordFile).Where(l => l.Length > 0).ToList() : new List<string>(); }
            catch { return new List<string>(); }
        }

        static void AddToBlacklist(string inst)
        {
            var bl = FromMulti(GetList(GET_BLACKLIST));
            if (bl.Any(x => string.Equals(x, inst, StringComparison.OrdinalIgnoreCase))) return; // already hidden by the user: leave it to them
            var rec = Recorded();
            if (!rec.Contains(inst))
            {
                rec.Add(inst);
                Directory.CreateDirectory(Path.GetDirectoryName(RecordFile));
                File.WriteAllLines(RecordFile, rec);
            }
            bl.Add(inst);
            Put(SET_BLACKLIST, ToMulti(bl));
        }

        /// <summary>Take back what we added (also the leftovers of a run that crashed).</summary>
        public static void RemoveRecorded()
        {
            var rec = Recorded();
            if (rec.Count == 0 || !OpenHidHide()) return;
            try
            {
                var bl = FromMulti(GetList(GET_BLACKLIST));
                var left = bl.Where(x => !rec.Any(r => string.Equals(r, x, StringComparison.OrdinalIgnoreCase))).ToList();
                if (left.Count != bl.Count) Put(SET_BLACKLIST, ToMulti(left));
                File.Delete(RecordFile);
            }
            catch (Exception e) { lastError = e.Message; }
        }

        /// <summary>Restart a device (not persistent, like replugging it). Needs admin, as HidHide does.</summary>
        static void RestartDevice(string instance)
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "pnputil.exe"), "/restart-device \"" + instance + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                Pad.ScanFast(6000);
                using (var p = System.Diagnostics.Process.Start(psi))
                {
                    var output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(15000);
                    Pad.ScanFast(6000);
                    if (p.ExitCode != 0 && p.ExitCode != 3010) lastError = "Couldn't restart the controller (" + output.Trim() + "). Reconnect it once.";
                }
            }
            catch (Exception e) { lastError = "Couldn't restart the controller: " + e.Message + ". Reconnect it once."; }
        }

        static void UnhideAll()
        {
            List<string> was;
            lock (Gate)
            {
                was = Hidden.ToList();
                Hidden.Clear();
            }
            if (control == null) return;
            if (!sessionUnsupported) try { Put(CLR_SESSION, null); } catch { }
            RemoveRecorded();
            // Reconnect them so games pick the real controller up again right away.
            foreach (var inst in was)
            {
                var i = inst;
                new Thread(() => RestartDevice(i)) { IsBackground = true, Name = "pad-restart" }.Start();
            }
            if (restoreInactive)
            {
                try { Put(SET_ACTIVE, new byte[] { 0 }); } catch { }
                restoreInactive = false;
            }
        }

        /* ---------------- VIIPER ---------------- */

        const int ApiPort = 3242;
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        static Dictionary<string, object> Api(string request)
        {
            using (var c = new System.Net.Sockets.TcpClient())
            {
                var ar = c.BeginConnect("127.0.0.1", ApiPort, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(1500) || !c.Connected) throw new InvalidOperationException("VIIPER isn't running");
                c.EndConnect(ar);
                c.ReceiveTimeout = 5000;
                var s = c.GetStream();
                var bytes = Encoding.UTF8.GetBytes(request + "\0");
                s.Write(bytes, 0, bytes.Length);
                var ms = new MemoryStream();
                var buf = new byte[4096];
                int n;
                while ((n = s.Read(buf, 0, buf.Length)) > 0) ms.Write(buf, 0, n);
                var text = Encoding.UTF8.GetString(ms.ToArray()).Trim('\0', ' ', '\r', '\n');
                var obj = text.Length > 0 ? Json.Deserialize<Dictionary<string, object>>(text) : new Dictionary<string, object>();
                if (obj.ContainsKey("status") && obj.ContainsKey("title")) throw new InvalidOperationException("VIIPER: " + obj["title"] + (obj.ContainsKey("detail") ? " (" + obj["detail"] + ")" : ""));
                return obj;
            }
        }

        static bool SetupViiper()
        {
            try
            {
                Api("ping");
                RemoveLeftovers();
                var created = Api("bus/create");
                busId = Convert.ToInt32(created["busId"]);
                viiper = "ok";
                return true;
            }
            catch (Exception e)
            {
                viiper = e.Message.Contains("isn't running") ? "missing" : "error";
                lastError = e.Message;
                return false;
            }
        }

        /// <summary>Buses holding only virtual DualSenses are ours from an earlier run.</summary>
        static void RemoveLeftovers()
        {
            try
            {
                var buses = Api("bus/list");
                if (!buses.ContainsKey("buses") || !(buses["buses"] is System.Collections.IEnumerable)) return;
                foreach (var b in (System.Collections.IEnumerable)buses["buses"])
                {
                    var id = Convert.ToString(b);
                    var list = Api("bus/" + id + "/list");
                    var devs = list.ContainsKey("devices") ? list["devices"] as System.Collections.IEnumerable : null;
                    var ours = true;
                    if (devs != null)
                        foreach (var d in devs)
                        {
                            var dev = d as Dictionary<string, object>;
                            var type = dev != null && dev.ContainsKey("type") ? Convert.ToString(dev["type"]) : "";
                            if (type != "dualsense" && type != "dualsenseedge") ours = false;
                        }
                    if (!ours) continue;
                    if (devs != null)
                        foreach (var d in devs)
                        {
                            var dev = d as Dictionary<string, object>;
                            if (dev != null && dev.ContainsKey("devId")) try { Api("bus/" + id + "/remove " + dev["devId"]); } catch { }
                        }
                    try { Api("bus/remove " + id); } catch { }
                }
            }
            catch { }
        }

        /// <summary>What a DualSense is shown to games as: dualsense | dualshock4 | xbox360.</summary>
        static string emulation = "dualsense";

        class Virtual
        {
            public string Path;      // real DualSense device path
            public string Kind;      // dualsense | dualsenseedge | dualshock4 | xbox360
            public string DevId;
            public System.Net.Sockets.TcpClient Stream;
            public bool Bluetooth;
            public byte[] Last = new byte[33]; // last DualSense-layout frame
            public byte[] LastOut;
            public Microsoft.Win32.SafeHandles.SafeFileHandle Write;
            public int OutLen;
            public byte Seq;
            public bool AskedFull;
        }

        static int FeedbackSize(string kind)
        {
            return kind == "xbox360" ? 2 : kind == "dualshock4" ? 8 : 6;
        }

        static Virtual Attach(Virtual v)
        {
            if (v.Kind == "xbox360") XInputExpectVirtual();
            var added = Api("bus/" + busId + "/add {\"type\":\"" + v.Kind + "\"}");
            v.DevId = Convert.ToString(added["devId"]);
            var c = new System.Net.Sockets.TcpClient { NoDelay = true };
            c.Connect("127.0.0.1", ApiPort);
            var hello = Encoding.UTF8.GetBytes("bus/" + busId + "/" + v.DevId + "\0");
            c.GetStream().Write(hello, 0, hello.Length);
            v.Stream = c;
            v.LastOut = new byte[FeedbackSize(v.Kind)];
            new Thread(() => Feedback(v)) { IsBackground = true, Name = "vpad-out" }.Start();
            return v;
        }

        static Virtual Create(string path, string pid)
        {
            var v = new Virtual { Path = path, Bluetooth = path.IndexOf("{00001124", StringComparison.OrdinalIgnoreCase) >= 0 };
            v.Kind = emulation == "dualsense" ? (pid == "0df2" ? "dualsenseedge" : "dualsense") : emulation;
            // The real controller, opened for writing rumble / lightbar.
            v.Write = CreateFile(path, 0x40000000, 0x1 | 0x2, IntPtr.Zero, 3, 0, IntPtr.Zero);
            v.OutLen = v.Bluetooth ? 78 : 48;
            return Attach(v);
        }

        static void Destroy(Virtual v)
        {
            try { v.Stream.Close(); } catch { }
            try { if (v.Write != null) v.Write.Dispose(); } catch { }
            try { Api("bus/" + busId + "/remove " + v.DevId); } catch { }
            if (v.Kind == "xbox360") XInputForgetVirtual(v.DevId);
        }

        /* ---------------- DualSense frame -> other pads ---------------- */

        /// <summary>VIIPER DualShock 4 state (31 bytes) from a DualSense frame.</summary>
        static byte[] ToDs4(byte[] f)
        {
            var d = new byte[31];
            Array.Copy(f, 0, d, 0, 4);                         // sticks
            uint ds = (uint)(f[4] | (f[5] << 8) | (f[6] << 16) | (f[7] << 24));
            int b = (int)(ds & 0xFFF0);                        // face, shoulders, share, options, L3, R3: same bits
            if ((ds & 0x10000) != 0) b |= 0x0001;              // PS
            if ((ds & 0x20000) != 0) b |= 0x0002;              // touchpad click
            d[4] = (byte)b; d[5] = (byte)(b >> 8);
            d[6] = f[8];                                       // d-pad
            d[7] = f[9]; d[8] = f[10];                         // L2 / R2
            for (int t = 0; t < 2; t++)
            {
                int at = 11 + t * 5, to = 9 + t * 5;
                d[to] = f[at]; d[to + 1] = f[at + 1];          // x (same range)
                int y = f[at + 2] | (f[at + 3] << 8);
                PutU16(d, to + 2, y * 942 / 1080);             // the DS4 touchpad is shorter
                d[to + 4] = f[at + 4];
            }
            Array.Copy(f, 21, d, 19, 12);                      // gyro + accel (near-identical scales)
            return d;
        }

        /// <summary>VIIPER Xbox 360 state (20 bytes) from a DualSense frame.</summary>
        static byte[] ToX360(byte[] f)
        {
            var x = new byte[20];
            uint ds = (uint)(f[4] | (f[5] << 8) | (f[6] << 16) | (f[7] << 24));
            int b = f[8] & 0x0F;                               // d-pad: same bits
            if ((ds & 0x2000) != 0) b |= 0x0010;               // Options -> Start
            if ((ds & 0x1000) != 0 || (ds & 0x20000) != 0) b |= 0x0020; // Create / touchpad -> Back
            if ((ds & 0x4000) != 0) b |= 0x0040;               // L3
            if ((ds & 0x8000) != 0) b |= 0x0080;               // R3
            if ((ds & 0x0100) != 0) b |= 0x0100;               // L1
            if ((ds & 0x0200) != 0) b |= 0x0200;               // R1
            if ((ds & 0x0020) != 0) b |= 0x1000;               // Cross -> A
            if ((ds & 0x0040) != 0) b |= 0x2000;               // Circle -> B
            if ((ds & 0x0010) != 0) b |= 0x4000;               // Square -> X
            if ((ds & 0x0080) != 0) b |= 0x8000;               // Triangle -> Y
            x[0] = (byte)b; x[1] = (byte)(b >> 8);
            x[4] = f[9]; x[5] = f[10];
            PutI16(x, 6, Axis((sbyte)f[0]));
            PutI16(x, 8, Axis(-(sbyte)f[1]));                  // Xbox: up is positive
            PutI16(x, 10, Axis((sbyte)f[2]));
            PutI16(x, 12, Axis(-(sbyte)f[3]));
            return x;
        }

        static int Axis(int v) { v = Math.Max(-128, Math.Min(127, v)); return v < 0 ? v * 256 : v * 258; }
        static void PutI16(byte[] f, int at, int v) { f[at] = (byte)v; f[at + 1] = (byte)(v >> 8); }

        /// <summary>The frame to send for this virtual pad's type.</summary>
        static byte[] Frame(Virtual v, byte[] dsFrame)
        {
            if (v.Kind == "dualshock4") return ToDs4(dsFrame);
            if (v.Kind == "xbox360") return ToX360(dsFrame);
            return dsFrame;
        }

        /* ---------------- Input: real -> virtual ---------------- */

        [DllImport("hid.dll")] static extern bool HidD_GetFeature(Microsoft.Win32.SafeHandles.SafeFileHandle h, byte[] buf, int len);

        /// <summary>A Bluetooth DualSense sends short reports until its calibration report has been read.</summary>
        static void AskFullReports(Virtual v)
        {
            v.AskedFull = true;
            try
            {
                using (var h = CreateFile(v.Path, 0x80000000 | 0x40000000, 0x1 | 0x2, IntPtr.Zero, 3, 0, IntPtr.Zero))
                {
                    if (h.IsInvalid) return;
                    var b = new byte[64];
                    b[0] = 0x05;
                    HidD_GetFeature(h, b, 41);
                }
            }
            catch { }
        }

        static void PutU16(byte[] f, int at, int v) { f[at] = (byte)v; f[at + 1] = (byte)(v >> 8); }

        /// <summary>DualSense HID input report -> VIIPER's 33-byte DualSense state.</summary>
        static byte[] State(byte[] b, int n)
        {
            var f = new byte[33];
            int o;
            bool full;
            if (b[0] == 0x01 && n >= 64) { o = 1; full = true; }          // USB
            else if (b[0] == 0x31 && n >= 64) { o = 2; full = true; }     // Bluetooth, full report
            else if (b[0] == 0x01 && n >= 10) { o = 1; full = false; }    // Bluetooth, short report
            else return null;
            int lx = b[o], ly = b[o + 1], rx = b[o + 2], ry = b[o + 3];
            int l2, r2, b0, b1, b2;
            if (full) { l2 = b[o + 4]; r2 = b[o + 5]; b0 = b[o + 7]; b1 = b[o + 8]; b2 = b[o + 9]; }
            else { b0 = b[o + 4]; b1 = b[o + 5]; b2 = b[o + 6]; l2 = b[o + 7]; r2 = b[o + 8]; }
            f[0] = (byte)(sbyte)(lx - 128);
            f[1] = (byte)(sbyte)(ly - 128);
            f[2] = (byte)(sbyte)(rx - 128);
            f[3] = (byte)(sbyte)(ry - 128);
            // Same bit layout as the report: face buttons, then shoulders/sticks, then PS/touchpad/mute.
            // The PS button stays with the launcher (it opens the quick menu), like on a PS5.
            uint buttons = (uint)(b0 & 0xF0) | ((uint)b1 << 8) | ((uint)(b2 & ~0x01) << 16);
            // While recording is on, the Create button opens the capture menu instead.
            if (StripCreate) buttons &= ~0x1000u;
            f[4] = (byte)buttons; f[5] = (byte)(buttons >> 8); f[6] = (byte)(buttons >> 16); f[7] = (byte)(buttons >> 24);
            int hat = b0 & 0x0F;
            byte dpad = 0;
            if (hat == 0 || hat == 1 || hat == 7) dpad |= 0x01;
            if (hat == 3 || hat == 4 || hat == 5) dpad |= 0x02;
            if (hat == 5 || hat == 6 || hat == 7) dpad |= 0x04;
            if (hat == 1 || hat == 2 || hat == 3) dpad |= 0x08;
            f[8] = dpad;
            f[9] = (byte)l2;
            f[10] = (byte)r2;
            if (full)
            {
                for (int t = 0; t < 2; t++)
                {
                    int p = o + 32 + t * 4, at = 11 + t * 5;
                    bool active = (b[p] & 0x80) == 0;
                    int x = b[p + 1] | ((b[p + 2] & 0x0F) << 8);
                    int y = (b[p + 2] >> 4) | (b[p + 3] << 4);
                    PutU16(f, at, Math.Min(x, 1919));
                    PutU16(f, at + 2, Math.Min(y, 1079));
                    f[at + 4] = (byte)(active ? 1 : 0);
                }
                Array.Copy(b, o + 15, f, 21, 12); // gyro x/y/z, accel x/y/z (raw int16)
            }
            else
            {
                PutU16(f, 31, unchecked((ushort)-8192)); // resting, flat
            }
            return f;
        }

        /// <summary>Same motion, nothing pressed, sticks centred.</summary>
        static byte[] Neutral(byte[] last)
        {
            var f = new byte[33];
            Array.Copy(last, 21, f, 21, 12);
            return f;
        }

        public static void OnReport(string path, string pid, byte[] buf, int n)
        {
            if (!Enabled || (pid != "0ce6" && pid != "0df2")) return;
            Virtual v;
            lock (Gate) Pads.TryGetValue(path, out v);
            if (v == null) return;
            if (v.Bluetooth && !v.AskedFull && buf[0] == 0x01 && n < 64) AskFullReports(v);
            var f = State(buf, n);
            if (f == null) return;
            v.Last = f;
            Push(v);
        }

        /// <summary>Send the pad's current state (or a neutral one while muted) in its type's format.</summary>
        static void Push(Virtual v)
        {
            var frame = Frame(v, Muted ? Neutral(v.Last) : v.Last);
            try { v.Stream.GetStream().Write(frame, 0, frame.Length); }
            catch { }
        }

        /* ---------------- Our own virtual Xbox 360 pads ----------------
           With "emulate as Xbox" the virtual pad shows up in XInput; the XInput
           reader must not take it for a real controller. */

        static readonly HashSet<int> VirtualSlots = new HashSet<int>();
        static readonly Dictionary<string, int> SlotOfDev = new Dictionary<string, int>();
        static int expectVirtual;
        static long expectUntil;

        /// <summary>A virtual Xbox 360 pad is about to be added: the next new XInput slot is it.</summary>
        static void XInputExpectVirtual()
        {
            lock (VirtualSlots)
            {
                expectVirtual++;
                expectUntil = Environment.TickCount + 6000;
            }
        }

        static void XInputForgetVirtual(string devId)
        {
            lock (VirtualSlots)
            {
                int slot;
                if (devId != null && SlotOfDev.TryGetValue(devId, out slot))
                {
                    SlotOfDev.Remove(devId);
                    VirtualSlots.Remove(slot);
                }
            }
        }

        /// <summary>Called by the XInput reader when a slot becomes connected. True: one of ours.</summary>
        public static bool XInputSlotAppeared(int slot)
        {
            lock (VirtualSlots)
            {
                if (VirtualSlots.Contains(slot)) return true;
                if (expectVirtual > 0 && Environment.TickCount - expectUntil < 0)
                {
                    expectVirtual--;
                    VirtualSlots.Add(slot);
                    // Tie it to the newest Xbox 360 device so it can be released later.
                    lock (Gate)
                    {
                        var v = Pads.Values.Where(p => p.Kind == "xbox360" && p.DevId != null && !SlotOfDev.ContainsKey(p.DevId)).LastOrDefault();
                        if (v != null) SlotOfDev[v.DevId] = slot;
                    }
                    return true;
                }
                return false;
            }
        }

        /// <summary>A slot went empty: whatever was there, it can be a real pad next time.</summary>
        public static void XInputSlotGone(int slot)
        {
            lock (VirtualSlots)
            {
                VirtualSlots.Remove(slot);
                foreach (var k in SlotOfDev.Where(p => p.Value == slot).Select(p => p.Key).ToList()) SlotOfDev.Remove(k);
            }
        }

        public static bool IsVirtualSlot(int slot)
        {
            lock (VirtualSlots) return VirtualSlots.Contains(slot);
        }

        public static bool ExpectingVirtual
        {
            get { lock (VirtualSlots) return expectVirtual > 0 && Environment.TickCount - expectUntil < 0; }
        }

        /// <summary>A real DualSense showed up (called from the HID reader).</summary>
        public static void OnConnected(string path, string pid)
        {
            if (!Enabled || (pid != "0ce6" && pid != "0df2") || busId < 0 || Pad.IsVirtual(path)) return;
            lock (Gate) if (Pads.ContainsKey(path)) return;
            Hide(path);
            try
            {
                var v = Create(path, pid);
                lock (Gate) Pads[path] = v;
                Notify();
            }
            catch (Exception e)
            {
                lastError = e.Message;
                Notify();
            }
        }

        public static void OnGone(string path)
        {
            Virtual v;
            lock (Gate)
            {
                if (!Pads.TryGetValue(path, out v)) return;
                Pads.Remove(path);
            }
            Destroy(v);
            Notify();
        }

        /* ---------------- Output: game -> real controller ---------------- */

        static uint[] crcTable;
        static uint Crc32(byte[] data, int start, int len, uint crc)
        {
            if (crcTable == null)
            {
                crcTable = new uint[256];
                for (uint i = 0; i < 256; i++)
                {
                    var c = i;
                    for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
                    crcTable[i] = c;
                }
            }
            for (int i = start; i < start + len; i++) crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
            return crc;
        }

        [DllImport("kernel32", SetLastError = true)]
        static extern bool WriteFile(Microsoft.Win32.SafeHandles.SafeFileHandle h, byte[] buf, int len, out int written, IntPtr overlapped);

        static void Feedback(Virtual v)
        {
            var size = FeedbackSize(v.Kind);
            var buf = new byte[size];
            try
            {
                var s = v.Stream.GetStream();
                while (true)
                {
                    int got = 0;
                    while (got < size)
                    {
                        var n = s.Read(buf, got, size - got);
                        if (n <= 0) return;
                        got += n;
                    }
                    if (buf.SequenceEqual(v.LastOut)) continue;
                    Array.Copy(buf, v.LastOut, size);
                    if (v.Kind == "xbox360") WriteOutput(v, buf[1], buf[0], 0, 0, 0, 0, false);
                    else if (v.Kind == "dualshock4")
                    {
                        // flags: 0x01 rumble, 0x02 lightbar
                        if ((buf[0] & 0x02) != 0) WriteOutput(v, buf[1], buf[2], buf[3], buf[4], buf[5], 0, true);
                        else WriteOutput(v, buf[1], buf[2], 0, 0, 0, 0, false);
                    }
                    else WriteOutput(v, buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], true);
                }
            }
            catch { }
        }

        /// <summary>Rumble, lightbar and player lights to the real DualSense (USB report 0x02 / Bluetooth 0x31).</summary>
        static void WriteOutput(Virtual v, byte small, byte large, byte r, byte g, byte b, byte players, bool lights)
        {
            if (v.Write == null || v.Write.IsInvalid) return;
            var rep = new byte[v.OutLen];
            int c; // start of the common block
            if (v.Bluetooth)
            {
                rep[0] = 0x31;
                rep[1] = (byte)(v.Seq << 4);
                v.Seq = (byte)((v.Seq + 1) & 0x0F);
                rep[2] = 0x10;
                c = 3;
            }
            else
            {
                rep[0] = 0x02;
                c = 1;
            }
            rep[c + 0] = 0x01 | 0x02; // rumble (compatible vibration)
            rep[c + 1] = (byte)(lights ? 0x04 | 0x10 : 0); // lightbar + player lights (left alone for Xbox / DS4 without a colour)
            rep[c + 2] = small;
            rep[c + 3] = large;
            rep[c + 43] = players;
            rep[c + 44] = r;
            rep[c + 45] = g;
            rep[c + 46] = b;
            if (v.Bluetooth)
            {
                var crc = Crc32(new byte[] { 0xA2 }, 0, 1, 0xFFFFFFFF);
                crc = ~Crc32(rep, 0, 74, crc);
                rep[74] = (byte)crc; rep[75] = (byte)(crc >> 8); rep[76] = (byte)(crc >> 16); rep[77] = (byte)(crc >> 24);
            }
            int written;
            WriteFile(v.Write, rep, rep.Length, out written, IntPtr.Zero);
        }

        /* ---------------- Control ---------------- */

        static void Notify()
        {
            Program.Emit(new Dictionary<string, object> { { "event", "passthrough" }, { "state", Status() } });
        }

        public static object Status()
        {
            lock (Gate)
            {
                return new Dictionary<string, object>
                {
                    { "enabled", Enabled },
                    { "muted", Muted },
                    { "hidhide", hidhide },
                    { "viiper", viiper },
                    { "devices", Pads.Count },
                    { "emulation", emulation },
                    { "allowed", allowed.ToArray() },
                    { "inverse", inverse },
                    { "error", lastError },
                };
            }
        }

        /// <summary>Change what the DualSense is shown as; live virtual pads are rebuilt.</summary>
        public static object Configure(string mode)
        {
            if (mode != "dualsense" && mode != "dualshock4" && mode != "xbox360") mode = "dualsense";
            if (mode == emulation) return Status();
            emulation = mode;
            if (!Enabled) return Status();
            List<Virtual> rebuild;
            lock (Gate)
            {
                rebuild = Pads.Values.ToList();
                Pads.Clear();
            }
            foreach (var v in rebuild) Destroy(v);
            foreach (var p in Pad.PlayStationPaths()) OnConnected(p.Key, p.Value);
            Notify();
            return Status();
        }

        public static object Enable(bool on)
        {
            if (!on && !Enabled)
            {
                RemoveRecorded(); // left over from a run that didn't shut down cleanly
                return Status();
            }
            if (on == Enabled) return Status();
            if (on)
            {
                lastError = null;
                if (!SetupHidHide() || !SetupViiper())
                {
                    UnhideAll();
                    return Status();
                }
                Enabled = true;
                foreach (var p in Pad.PlayStationPaths()) OnConnected(p.Key, p.Value);
            }
            else Disable();
            Notify();
            return Status();
        }

        public static void Disable()
        {
            Enabled = false;
            List<Virtual> all;
            lock (Gate)
            {
                all = Pads.Values.ToList();
                Pads.Clear();
            }
            foreach (var v in all) Destroy(v);
            if (busId >= 0)
            {
                try { Api("bus/remove " + busId); } catch { }
                busId = -1;
            }
            UnhideAll();
        }

        public static object SetMuted(bool m)
        {
            Muted = m;
            List<Virtual> all;
            lock (Gate) all = Pads.Values.ToList();
            foreach (var v in all) Push(v);
            return true;
        }
    }

    static class Pad
    {
        const int UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8, CONFIRM = 16, BACK = 32, X = 64, Y = 128, OPTIONS = 256, SELECT = 512, L1 = 1024, R1 = 2048, GUIDE = 4096;
        static readonly int[] Bits = { UP, DOWN, LEFT, RIGHT, CONFIRM, BACK, X, Y, OPTIONS, SELECT, L1, R1, GUIDE };
        static readonly string[] Names = { "up", "down", "left", "right", "confirm", "back", "x", "y", "options", "select", "l1", "r1", "guide" };

        public static volatile bool Forward;
        static readonly object Gate = new object();
        static readonly Dictionary<string, int> Prev = new Dictionary<string, int>();
        static readonly Dictionary<string, long> HoldSince = new Dictionary<string, long>();
        static readonly Dictionary<string, long> NextRepeat = new Dictionary<string, long>();
        static readonly Dictionary<string, int> RepeatCount = new Dictionary<string, int>();
        static readonly HashSet<string> HidOpen = new HashSet<string>();
        static readonly List<string> HidSeen = new List<string>();
        static string xinputState = "not loaded";

        static long Now() { return Environment.TickCount; }

        static void Emit(string evt, string action, bool repeat)
        {
            var d = new Dictionary<string, object> { { "event", evt } };
            if (action != null) d["action"] = action;
            if (repeat) d["repeat"] = true;
            Program.Emit(d);
        }

        public static void Update(string src, int mask)
        {
            lock (Gate)
            {
                int prev;
                // A DualSense sends hundreds of reports a second; nearly all repeat the same buttons.
                if (Prev.TryGetValue(src, out prev) && prev == mask) return;
                Prev[src] = mask;
                var pressed = mask & ~prev;
                for (var i = 0; i < Bits.Length; i++)
                {
                    var bit = Bits[i];
                    var key = src + ":" + bit;
                    if ((pressed & bit) != 0)
                    {
                        if (bit == GUIDE) Emit("guide", null, false);
                        else
                        {
                            // Create button of a PlayStation controller: the capture menu.
                            if (bit == SELECT && src.StartsWith("h")) Emit("share", null, false);
                            if (Forward) Emit("pad", Names[i], false);
                        }
                        if (bit <= RIGHT)
                        {
                            HoldSince[key] = Now();
                            NextRepeat[key] = Now() + 380;
                            RepeatCount[key] = 0;
                        }
                    }
                    else if ((mask & bit) == 0 && HoldSince.ContainsKey(key))
                    {
                        HoldSince.Remove(key);
                        NextRepeat.Remove(key);
                        RepeatCount.Remove(key);
                    }
                }
            }
        }

        static void Repeats()
        {
            if (!Forward) return;
            lock (Gate)
            {
                var now = Now();
                foreach (var key in NextRepeat.Keys.ToList())
                {
                    if (now < NextRepeat[key]) continue;
                    var n = ++RepeatCount[key];
                    NextRepeat[key] = now + (n > 6 ? 65 : n > 2 ? 90 : 120);
                    var bit = int.Parse(key.Substring(key.LastIndexOf(':') + 1));
                    Emit("pad", Names[Array.IndexOf(Bits, bit)], true);
                }
            }
        }

        public static void Start()
        {
            new Thread(XInputLoop) { IsBackground = true, Name = "xinput" }.Start();
            new Thread(HidScanLoop) { IsBackground = true, Name = "hidscan" }.Start();
        }

        /// <summary>True when no button on any controller is held.</summary>
        public static bool Idle()
        {
            lock (Gate)
            {
                foreach (var m in Prev.Values) if (m != 0) return false;
                return true;
            }
        }

        /// <summary>
        /// Wait (up to timeoutMs) until every button is released. Pausing or
        /// resuming a game mid-press would leave it with a stuck button, e.g.
        /// Eden would see Home held + B pressed = its "toggle fullscreen" shortcut.
        /// </summary>
        public static void WaitIdle(int timeoutMs)
        {
            var end = Now() + timeoutMs;
            while (!Idle() && Now() < end) Thread.Sleep(15);
            // Let the game read one more "everything released" report.
            Thread.Sleep(40);
        }

        public static object Info()
        {
            lock (Gate)
            {
                return new Dictionary<string, object> { { "xinput", xinputState }, { "hidOpen", HidOpen.ToList() }, { "hidSeen", HidSeen.ToList() }, { "forward", Forward } };
            }
        }

        /* ---------------- XInput ---------------- */

        [StructLayout(LayoutKind.Sequential)]
        struct XINPUT_GAMEPAD { public ushort wButtons; public byte bLeftTrigger; public byte bRightTrigger; public short sThumbLX; public short sThumbLY; public short sThumbRX; public short sThumbRY; }

        [StructLayout(LayoutKind.Sequential)]
        struct XINPUT_STATE { public uint dwPacketNumber; public XINPUT_GAMEPAD Gamepad; }

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        delegate uint XInputGetStateFn(uint user, out XINPUT_STATE state);

        [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string name);
        [DllImport("kernel32", EntryPoint = "GetProcAddress")] static extern IntPtr GetProcAddressOrdinal(IntPtr h, IntPtr ordinal);
        [DllImport("kernel32", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr h, string name);

        static void XInputLoop()
        {
            XInputGetStateFn get = null;
            try
            {
                var lib = LoadLibrary("xinput1_4.dll");
                if (lib == IntPtr.Zero) lib = LoadLibrary("xinput1_3.dll");
                if (lib != IntPtr.Zero)
                {
                    var p = GetProcAddressOrdinal(lib, (IntPtr)100); // XInputGetStateEx: includes Guide
                    xinputState = "guide";
                    if (p == IntPtr.Zero)
                    {
                        p = GetProcAddress(lib, "XInputGetState");
                        xinputState = "no guide";
                    }
                    if (p != IntPtr.Zero) get = (XInputGetStateFn)Marshal.GetDelegateForFunctionPointer(p, typeof(XInputGetStateFn));
                }
            }
            catch { }
            if (get == null) xinputState = "unavailable";
            var connected = new bool[4];
            var lastProbe = new long[4];
            while (true)
            {
                if (get != null)
                {
                    for (uint i = 0; i < 4; i++)
                    {
                        // Probing empty slots is slow, so only do it every 2 seconds
                        // (faster while a virtual Xbox pad of ours is about to show up).
                        if (!connected[i] && Now() - lastProbe[i] < (Passthrough.ExpectingVirtual ? 150 : 2000)) continue;
                        XINPUT_STATE st;
                        var r = get(i, out st);
                        if (r != 0)
                        {
                            if (connected[i])
                            {
                                Update("x" + i, 0);
                                Passthrough.XInputSlotGone((int)i);
                            }
                            connected[i] = false;
                            lastProbe[i] = Now();
                            continue;
                        }
                        if (!connected[i] && Passthrough.XInputSlotAppeared((int)i)) { connected[i] = true; continue; }
                        connected[i] = true;
                        // Our own virtual Xbox pads aren't menu input.
                        if (Passthrough.IsVirtualSlot((int)i)) continue;
                        var b = st.Gamepad.wButtons;
                        var m = 0;
                        if ((b & 0x0001) != 0 || st.Gamepad.sThumbLY > 16000) m |= UP;
                        if ((b & 0x0002) != 0 || st.Gamepad.sThumbLY < -16000) m |= DOWN;
                        if ((b & 0x0004) != 0 || st.Gamepad.sThumbLX < -16000) m |= LEFT;
                        if ((b & 0x0008) != 0 || st.Gamepad.sThumbLX > 16000) m |= RIGHT;
                        if ((b & 0x0010) != 0) m |= OPTIONS;
                        if ((b & 0x0020) != 0) m |= SELECT;
                        if ((b & 0x0100) != 0) m |= L1;
                        if ((b & 0x0200) != 0) m |= R1;
                        if ((b & 0x0400) != 0) m |= GUIDE;
                        if ((b & 0x1000) != 0) m |= CONFIRM;
                        if ((b & 0x2000) != 0) m |= BACK;
                        if ((b & 0x4000) != 0) m |= X;
                        if ((b & 0x8000) != 0) m |= Y;
                        Update("x" + i, m);
                    }
                }
                Repeats();
                // No XInput pad to read and no menu open: empty slots are only probed every 2 s anyway.
                var busy = connected[0] || connected[1] || connected[2] || connected[3] || Forward || Passthrough.ExpectingVirtual;
                Thread.Sleep(busy ? 16 : 100);
            }
        }

        /* ---------------- HID (PlayStation controllers) ---------------- */

        [StructLayout(LayoutKind.Sequential)]
        struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }

        [StructLayout(LayoutKind.Sequential)]
        struct HIDP_CAPS
        {
            public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
            public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices, NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices, NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
        }

        [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid g);
        [DllImport("hid.dll")] static extern bool HidD_GetPreparsedData(Microsoft.Win32.SafeHandles.SafeFileHandle h, out IntPtr data);
        [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr data);
        [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr data, out HIDP_CAPS caps);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr enumerator, IntPtr hwnd, uint flags);
        [DllImport("setupapi.dll")] static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr devInfo, ref Guid g, int index, ref SP_DEVICE_INTERFACE_DATA data);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA data, IntPtr detail, int size, out int required, IntPtr devInfo);
        [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
        [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32", SetLastError = true)] static extern bool ReadFile(Microsoft.Win32.SafeHandles.SafeFileHandle h, byte[] buf, int len, out int read, IntPtr overlapped);

        static readonly System.Text.RegularExpressions.Regex PsPad = new System.Text.RegularExpressions.Regex(
            "vid[_&](?:0002)?054c[_&]pid[_&](0ce6|0df2|05c4|09cc|0ba0)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        static List<string> HidPaths()
        {
            var list = new List<string>();
            Guid g;
            HidD_GetHidGuid(out g);
            var set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x2 | 0x10);
            if (set == IntPtr.Zero || set == new IntPtr(-1)) return list;
            try
            {
                for (var i = 0; ; i++)
                {
                    var data = new SP_DEVICE_INTERFACE_DATA { cbSize = Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA)) };
                    if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref data)) break;
                    int need;
                    SetupDiGetDeviceInterfaceDetail(set, ref data, IntPtr.Zero, 0, out need, IntPtr.Zero);
                    if (need <= 0) continue;
                    var buf = Marshal.AllocHGlobal(need);
                    try
                    {
                        Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);
                        if (SetupDiGetDeviceInterfaceDetail(set, ref data, buf, need, out need, IntPtr.Zero))
                            list.Add(Marshal.PtrToStringUni(buf + 4));
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buf);
                    }
                }
            }
            finally
            {
                SetupDiDestroyDeviceInfoList(set);
            }
            return list;
        }

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Locate_DevNode(out uint node, string id, int flags);
        [DllImport("cfgmgr32.dll")] static extern int CM_Get_Parent(out uint parent, uint node, int flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_Device_ID(uint node, StringBuilder buf, int len, int flags);
        static readonly Dictionary<string, bool> VirtualCache = new Dictionary<string, bool>();

        /// <summary>"\\?\hid#vid_054c&amp;pid_0ce6#3&amp;abc&amp;0&amp;0000#{guid}" -> "HID\VID_054C&amp;PID_0CE6\3&amp;ABC&amp;0&amp;0000".</summary>
        public static string InstancePath(string devicePath)
        {
            var p = devicePath;
            if (p.StartsWith("\\\\?\\")) p = p.Substring(4);
            var cut = p.LastIndexOf("#{", StringComparison.Ordinal);
            if (cut > 0) p = p.Substring(0, cut);
            return p.Replace('#', '\\').ToUpperInvariant();
        }

        /// <summary>
        /// A controller on a software bus (VIIPER's virtual DualSense sits under the
        /// root-enumerated USBip host controller). Real controllers hang off PCI/ACPI.
        /// Without this the helper would mirror its own virtual pads, again and again.
        /// </summary>
        public static bool IsVirtual(string path)
        {
            lock (VirtualCache)
            {
                bool known;
                if (VirtualCache.TryGetValue(path, out known)) return known;
            }
            var result = false;
            uint node;
            if (CM_Locate_DevNode(out node, InstancePath(path), 0) == 0)
            {
                var sb = new StringBuilder(512);
                for (var depth = 0; depth < 16; depth++)
                {
                    uint parent;
                    if (CM_Get_Parent(out parent, node, 0) != 0) break;
                    node = parent;
                    sb.Length = 0;
                    if (CM_Get_Device_ID(node, sb, sb.Capacity, 0) != 0) break;
                    var id = sb.ToString().ToUpperInvariant();
                    // Reached real hardware (a PCI/ACPI host controller): a real controller.
                    if (id.StartsWith("PCI\\") || id.StartsWith("ACPI") || id.StartsWith("HTREE\\")) break;
                    if (id.StartsWith("ROOT\\") || id.Contains("USBIP") || id.Contains("VIIPER")) { result = true; break; }
                }
            }
            lock (VirtualCache) VirtualCache[path] = result;
            return result;
        }

        /// <summary>PlayStation controllers being read right now: device path -> product id.</summary>
        public static Dictionary<string, string> PlayStationPaths()
        {
            var d = new Dictionary<string, string>();
            lock (Gate)
            {
                foreach (var p in HidOpen)
                {
                    var m = PsPad.Match(p);
                    if (m.Success) d[p] = m.Groups[1].Value.ToLowerInvariant();
                }
            }
            return d;
        }

        static void HidScanLoop()
        {
            while (true)
            {
                try
                {
                    foreach (var path in HidPaths())
                    {
                        var m = PsPad.Match(path);
                        if (!m.Success || IsVirtual(path)) continue;
                        lock (Gate)
                        {
                            if (!HidSeen.Contains(path)) HidSeen.Add(path);
                            if (HidOpen.Contains(path)) continue;
                            HidOpen.Add(path);
                        }
                        var pid = m.Groups[1].Value.ToLowerInvariant();
                        var p = path;
                        new Thread(() => HidReader(p, pid)) { IsBackground = true, Name = "hid" }.Start();
                    }
                }
                catch { }
                // Normally every 3 seconds; right after a controller restart, quickly.
                ScanWake.WaitOne(Environment.TickCount - fastScanUntil < 0 ? 150 : 3000);
            }
        }

        static readonly AutoResetEvent ScanWake = new AutoResetEvent(false);
        static int fastScanUntil = Environment.TickCount;

        /// <summary>Look for (re)connected controllers often for a while (after a restart).</summary>
        public static void ScanFast(int ms)
        {
            fastScanUntil = Environment.TickCount + ms;
            ScanWake.Set();
        }

        static void HidReader(string path, string pid)
        {
            var src = "h" + path.GetHashCode();
            try
            {
                using (var h = CreateFile(path, 0x80000000, 0x1 | 0x2, IntPtr.Zero, 3, 0, IntPtr.Zero))
                {
                    if (h.IsInvalid) return;
                    int len = 128;
                    IntPtr pre;
                    if (HidD_GetPreparsedData(h, out pre))
                    {
                        HIDP_CAPS caps;
                        if (HidP_GetCaps(pre, out caps) == 0x00110000 && caps.InputReportByteLength > 0) len = caps.InputReportByteLength;
                        HidD_FreePreparsedData(pre);
                    }
                    var buf = new byte[Math.Max(len, 16)];
                    Passthrough.OnConnected(path, pid);
                    while (true)
                    {
                        int read;
                        if (!ReadFile(h, buf, len, out read, IntPtr.Zero) || read <= 0) break;
                        var mask = ParsePs(buf, read, pid);
                        if (mask >= 0) Update(src, mask);
                        Passthrough.OnReport(path, pid, buf, read);
                    }
                }
            }
            catch { }
            finally
            {
                Update(src, 0);
                lock (Gate) HidOpen.Remove(path);
                Passthrough.OnGone(path);
            }
        }

        static int ParsePs(byte[] b, int n, string pid)
        {
            var dualsense = pid == "0ce6" || pid == "0df2";
            int lx, ly, b0, b1, b2;
            if (dualsense)
            {
                if (b[0] == 0x01 && n >= 64) { lx = 1; ly = 2; b0 = 8; b1 = 9; b2 = 10; }        // USB
                else if (b[0] == 0x31 && n >= 12) { lx = 2; ly = 3; b0 = 9; b1 = 10; b2 = 11; }  // Bluetooth (full report)
                else if (b[0] == 0x01 && n >= 8) { lx = 1; ly = 2; b0 = 5; b1 = 6; b2 = 7; }     // Bluetooth (simple report)
                else return -1;
            }
            else
            {
                if (b[0] == 0x01 && n >= 8) { lx = 1; ly = 2; b0 = 5; b1 = 6; b2 = 7; }          // DS4 USB / simple BT
                else if (b[0] == 0x11 && n >= 10) { lx = 3; ly = 4; b0 = 7; b1 = 8; b2 = 9; }    // DS4 Bluetooth
                else return -1;
            }
            var m = 0;
            var hat = b[b0] & 0x0F;
            if (hat == 7 || hat == 0 || hat == 1 || b[ly] < 50) m |= UP;
            if (hat == 3 || hat == 4 || hat == 5 || b[ly] > 205) m |= DOWN;
            if (hat == 5 || hat == 6 || hat == 7 || b[lx] < 50) m |= LEFT;
            if (hat == 1 || hat == 2 || hat == 3 || b[lx] > 205) m |= RIGHT;
            if ((b[b0] & 0x10) != 0) m |= X;        // square
            if ((b[b0] & 0x20) != 0) m |= CONFIRM;  // cross
            if ((b[b0] & 0x40) != 0) m |= BACK;     // circle
            if ((b[b0] & 0x80) != 0) m |= Y;        // triangle
            if ((b[b1] & 0x01) != 0) m |= L1;
            if ((b[b1] & 0x02) != 0) m |= R1;
            if ((b[b1] & 0x10) != 0) m |= SELECT;   // create / share
            if ((b[b1] & 0x20) != 0) m |= OPTIONS;
            if ((b[b2] & 0x01) != 0) m |= GUIDE;    // PS button
            return m;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Processes (running-game detection, closing games)                   */
    /* ------------------------------------------------------------------ */

    // Process names come from the system process list and full image paths
    // from NtQuerySystemInformation(SystemProcessIdInformation), so no handle to
    // any (game) process is ever opened.
    static class Procs
    {
        [StructLayout(LayoutKind.Sequential)]
        struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }

        [StructLayout(LayoutKind.Sequential)]
        struct SYSTEM_PROCESS_ID_INFORMATION { public IntPtr ProcessId; public UNICODE_STRING ImageName; }

        [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, ref SYSTEM_PROCESS_ID_INFORMATION info, int len, out int retLen);
        [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern uint QueryDosDevice(string device, StringBuilder target, int max);

        delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
        [DllImport("user32")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
        [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

        static Dictionary<string, string> devices;

        [DllImport("ntdll.dll", EntryPoint = "NtQuerySystemInformation")] static extern int NtQueryList(int cls, IntPtr info, int len, out int retLen);
        static readonly object ListGate = new object();
        static IntPtr listBuf = IntPtr.Zero;
        static int listLen;

        /// <summary>
        /// Every process's id and name (without ".exe"). Asked for every few
        /// seconds while games run, so it reads only those two fields from
        /// SystemProcessInformation into a reused buffer; Process.GetProcesses()
        /// would build objects for every thread of every process each time.
        /// </summary>
        public static object List()
        {
            lock (ListGate)
            {
                for (var tries = 0; tries < 5; tries++)
                {
                    if (listBuf == IntPtr.Zero)
                    {
                        listLen = Math.Max(listLen, 1 << 20);
                        listBuf = Marshal.AllocHGlobal(listLen);
                    }
                    int need;
                    var st = NtQueryList(5 /* SystemProcessInformation */, listBuf, listLen, out need);
                    if (st == unchecked((int)0xC0000004)) // STATUS_INFO_LENGTH_MISMATCH: grow and retry
                    {
                        Marshal.FreeHGlobal(listBuf);
                        listBuf = IntPtr.Zero;
                        listLen = Math.Max(need, listLen) + (256 << 10);
                        continue;
                    }
                    if (st != 0) break;
                    // SYSTEM_PROCESS_INFORMATION: ImageName (UNICODE_STRING) at 0x38, UniqueProcessId after BasePriority.
                    int bufferAt = IntPtr.Size == 8 ? 0x40 : 0x3C, pidAt = IntPtr.Size == 8 ? 0x50 : 0x44;
                    var list = new List<object>(512);
                    var p = listBuf;
                    while (true)
                    {
                        var next = Marshal.ReadInt32(p);
                        var len = (ushort)Marshal.ReadInt16(p, 0x38);
                        var namePtr = Marshal.ReadIntPtr(p, bufferAt);
                        var pid = (int)Marshal.ReadIntPtr(p, pidAt).ToInt64();
                        var name = pid == 0 ? "Idle" : namePtr == IntPtr.Zero ? "" : Marshal.PtrToStringUni(namePtr, len / 2);
                        if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
                        list.Add(new Dictionary<string, object> { { "pid", pid }, { "name", name } });
                        if (next == 0) break;
                        p += next;
                    }
                    return list;
                }
            }
            var all = new List<object>();
            foreach (var p in System.Diagnostics.Process.GetProcesses())
            {
                try { all.Add(new Dictionary<string, object> { { "pid", p.Id }, { "name", p.ProcessName } }); }
                catch { }
                p.Dispose();
            }
            return all;
        }

        static string ToDos(string nt)
        {
            if (devices == null)
            {
                var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (var c = 'A'; c <= 'Z'; c++)
                {
                    var sb = new StringBuilder(512);
                    if (QueryDosDevice(c + ":", sb, sb.Capacity) > 0) map[sb.ToString()] = c + ":";
                }
                devices = map;
            }
            foreach (var kv in devices)
            {
                if (nt.StartsWith(kv.Key + "\\", StringComparison.OrdinalIgnoreCase)) return kv.Value + nt.Substring(kv.Key.Length);
            }
            return nt;
        }

        public static string ImagePath(int pid)
        {
            var buf = Marshal.AllocHGlobal(4096);
            try
            {
                var info = new SYSTEM_PROCESS_ID_INFORMATION
                {
                    ProcessId = new IntPtr(pid),
                    ImageName = new UNICODE_STRING { Length = 0, MaximumLength = 4096, Buffer = buf },
                };
                int ret;
                if (NtQuerySystemInformation(88, ref info, Marshal.SizeOf(typeof(SYSTEM_PROCESS_ID_INFORMATION)), out ret) != 0) return null;
                return ToDos(Marshal.PtrToStringUni(buf, info.ImageName.Length / 2));
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
        }

        /// <summary>Ask a process to close by sending WM_CLOSE to its visible windows.</summary>
        public static int CloseWindows(int pid)
        {
            var n = 0;
            EnumWindowsProc cb = (h, l) =>
            {
                uint owner;
                GetWindowThreadProcessId(h, out owner);
                if (owner == pid && IsWindowVisible(h) && PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero)) n++;
                return true;
            };
            EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return n;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Foreground window                                                   */
    /* ------------------------------------------------------------------ */

    static class Fg
    {
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

        [DllImport("user32")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("user32")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("kernel32")] static extern uint GetCurrentThreadId();
        [DllImport("user32")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
        [DllImport("user32")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
        [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
        [DllImport("user32")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);

        [StructLayout(LayoutKind.Sequential)]
        struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor, rcWork;
            public uint dwFlags;
        }

        static RECT MonitorRect(IntPtr h)
        {
            var info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
            var m = MonitorFromWindow(h, 2 /* MONITOR_DEFAULTTONEAREST */);
            if (m != IntPtr.Zero && GetMonitorInfo(m, ref info)) return info.rcMonitor;
            return new RECT { L = 0, T = 0, R = 1920, B = 1080 };
        }

        public static object Get()
        {
            var h = GetForegroundWindow();
            if (h == IntPtr.Zero) return null;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            RECT r;
            GetWindowRect(h, out r);
            var m = MonitorRect(h);
            return new Dictionary<string, object>
            {
                { "hwnd", h.ToInt64() },
                { "pid", (int)pid },
                { "x", r.L }, { "y", r.T }, { "w", r.R - r.L }, { "h", r.B - r.T },
                { "mw", m.R - m.L }, { "mh", m.B - m.T },
                { "name", SafeName((int)pid) },
            };
        }

        static string SafeName(int pid)
        {
            try { return System.IO.Path.GetFileNameWithoutExtension(Procs.ImagePath(pid) ?? ""); } catch { return ""; }
        }

        /// <summary>
        /// Visible top-level windows of every process running from one of the
        /// given folders, with their size and their monitor's size. Process
        /// paths come from the system process list (no process handles).
        /// </summary>
        public static List<object> DirWindows(List<string> dirs)
        {
            var roots = dirs.Where(d => !string.IsNullOrEmpty(d))
                .Select(d => System.IO.Path.GetFullPath(d).TrimEnd('\\').ToLowerInvariant() + "\\").ToList();
            var list = new List<object>();
            if (roots.Count == 0) return list;
            var fg = GetForegroundWindow();
            var paths = new Dictionary<uint, string>();
            EnumWindowsProc cb = (h, l) =>
            {
                if (!IsWindowVisible(h) || GetWindow(h, 4 /* GW_OWNER */) != IntPtr.Zero) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                string path;
                if (!paths.TryGetValue(pid, out path))
                {
                    try { path = (Procs.ImagePath((int)pid) ?? "").ToLowerInvariant(); } catch { path = ""; }
                    paths[pid] = path;
                }
                if (path.Length == 0 || !roots.Any(root => path.StartsWith(root))) return true;
                RECT r;
                GetWindowRect(h, out r);
                var m = MonitorRect(h);
                var sb = new StringBuilder(256);
                GetWindowText(h, sb, sb.Capacity);
                list.Add(new Dictionary<string, object>
                {
                    { "hwnd", h.ToInt64() },
                    { "pid", (int)pid },
                    { "name", System.IO.Path.GetFileNameWithoutExtension(path) },
                    { "title", sb.ToString() },
                    { "w", r.R - r.L }, { "h", r.B - r.T },
                    { "mw", m.R - m.L }, { "mh", m.B - m.T },
                    { "fg", h == fg },
                });
                return true;
            };
            EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return list;
        }

        /// <summary>Bring a window to the foreground (the usual AttachThreadInput technique).</summary>
        public static bool Set(long hwnd)
        {
            var h = new IntPtr(hwnd);
            if (!IsWindow(h)) return false;
            var fg = GetForegroundWindow();
            if (fg == h) return true;
            uint ignored;
            var fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out ignored);
            var me = GetCurrentThreadId();
            var attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
            try
            {
                if (IsIconic(h)) ShowWindow(h, 9);
                BringWindowToTop(h);
                SetForegroundWindow(h);
                if (GetForegroundWindow() != h)
                {
                    keybd_event(0xE8, 0, 0, UIntPtr.Zero);
                    keybd_event(0xE8, 0, 2 /* KEYEVENTF_KEYUP */, UIntPtr.Zero);
                    BringWindowToTop(h);
                    SetForegroundWindow(h);
                }
            }
            finally
            {
                if (attached) AttachThreadInput(me, fgThread, false);
            }
            return GetForegroundWindow() == h;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Game windows: titles, focusing, pausing                             */
    /* ------------------------------------------------------------------ */

    static class GameWin
    {
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

        delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
        [DllImport("user32")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
        [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32")] static extern IntPtr GetWindow(IntPtr h, uint cmd);

        [DllImport("kernel32", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32")] static extern bool CloseHandle(IntPtr h);
        [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
        [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);

        static readonly object Gate = new object();
        static readonly HashSet<int> Suspended = new HashSet<int>();

        /// <summary>Visible, un-owned top-level windows of a process (by window manager only — no process handle).</summary>
        static List<IntPtr> Windows(int pid)
        {
            var list = new List<IntPtr>();
            EnumWindowsProc cb = (h, l) =>
            {
                uint owner;
                GetWindowThreadProcessId(h, out owner);
                if (owner == pid && IsWindowVisible(h) && GetWindow(h, 4 /* GW_OWNER */) == IntPtr.Zero) list.Add(h);
                return true;
            };
            EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return list;
        }

        public static object Titles(int pid)
        {
            var titles = new List<object>();
            foreach (var h in Windows(pid))
            {
                var sb = new StringBuilder(512);
                if (GetWindowText(h, sb, sb.Capacity) > 0) titles.Add(sb.ToString());
            }
            return titles;
        }

        /// <summary>Bring the biggest window of a process to the front.</summary>
        public static bool Focus(int pid)
        {
            IntPtr best = IntPtr.Zero;
            long bestArea = -1;
            foreach (var h in Windows(pid))
            {
                RECT r;
                GetWindowRect(h, out r);
                long area = (long)(r.R - r.L) * (r.B - r.T);
                if (area > bestArea)
                {
                    bestArea = area;
                    best = h;
                }
            }
            return best != IntPtr.Zero && Fg.Set(best.ToInt64());
        }

        /// <summary>
        /// Pause / resume a game while the menu is open. Only used for games without
        /// anti-cheat (the launcher checks the game folder first).
        /// </summary>
        public static bool Suspend(int pid, bool suspend)
        {
            lock (Gate)
            {
                if (suspend == Suspended.Contains(pid)) return true;
                var h = OpenProcess(0x0800 /* PROCESS_SUSPEND_RESUME */, false, pid);
                if (h == IntPtr.Zero) return false;
                try
                {
                    var st = suspend ? NtSuspendProcess(h) : NtResumeProcess(h);
                    if (st != 0) return false;
                    if (suspend) Suspended.Add(pid);
                    else Suspended.Remove(pid);
                    return true;
                }
                finally
                {
                    CloseHandle(h);
                }
            }
        }

        /// <summary>Never leave a game frozen: resume everything when the launcher goes away.</summary>
        public static void ResumeAll()
        {
            lock (Gate)
            {
                foreach (var pid in Suspended.ToList())
                {
                    var h = OpenProcess(0x0800, false, pid);
                    if (h == IntPtr.Zero) continue;
                    NtResumeProcess(h);
                    CloseHandle(h);
                }
                Suspended.Clear();
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* The launcher's own processes while a game runs                      */
    /* ------------------------------------------------------------------ */

    // Only ever called with the launcher's own (Electron) process ids. While a
    // game is in front they get Windows' efficiency mode (EcoQoS: efficient
    // cores, low clocks, no high-resolution timer requests) and a lower
    // priority, and their memory is trimmed, so the game gets the machine.
    static class Qos
    {
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_POWER_THROTTLING_STATE { public uint Version; public uint ControlMask; public uint StateMask; }

        [DllImport("kernel32", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32", SetLastError = true)] static extern bool SetProcessInformation(IntPtr h, int cls, ref PROCESS_POWER_THROTTLING_STATE info, int size);
        [DllImport("kernel32", SetLastError = true)] static extern bool SetPriorityClass(IntPtr h, uint cls);
        [DllImport("psapi", SetLastError = true)] static extern bool EmptyWorkingSet(IntPtr h);

        const uint SET_QUOTA = 0x0100, SET_INFORMATION = 0x0200, QUERY_LIMITED = 0x1000;
        const uint NORMAL_PRIORITY = 0x20, BELOW_NORMAL_PRIORITY = 0x4000;
        const uint EXECUTION_SPEED = 0x1, IGNORE_TIMER_RESOLUTION = 0x4;

        /// <summary>eco: efficiency mode on/off (off = Windows decides again). trim: page out what isn't in use.</summary>
        public static int Apply(IEnumerable<int> pids, bool eco, bool lower, bool trim)
        {
            var n = 0;
            foreach (var pid in pids)
            {
                var h = OpenProcess(SET_QUOTA | SET_INFORMATION | QUERY_LIMITED, false, pid);
                if (h == IntPtr.Zero) continue;
                try
                {
                    var mask = EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION;
                    var st = new PROCESS_POWER_THROTTLING_STATE { Version = 1, ControlMask = eco ? mask : 0, StateMask = eco ? mask : 0 };
                    SetProcessInformation(h, 4 /* ProcessPowerThrottling */, ref st, Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE)));
                    SetPriorityClass(h, eco && lower ? BELOW_NORMAL_PRIORITY : NORMAL_PRIORITY);
                    if (trim) EmptyWorkingSet(h);
                    n++;
                }
                finally
                {
                    CloseHandle(h);
                }
            }
            return n;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Network: is a game online right now?                               */
    /* ------------------------------------------------------------------ */

    // Reads the system TCP table (no handle to the game). Used to avoid pausing
    // games that are connected to a server, which would disconnect them.
    static class Net
    {
        [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool sort, int af, int tableClass, int reserved);

        public static int Established(int pid)
        {
            return Count(pid, 2) + Count(pid, 23);
        }

        static int Count(int pid, int af)
        {
            int size = 0;
            GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, 4 /* TCP_TABLE_OWNER_PID_CONNECTIONS */, 0);
            if (size <= 0) return 0;
            var buf = Marshal.AllocHGlobal(size);
            try
            {
                if (GetExtendedTcpTable(buf, ref size, false, af, 4, 0) != 0) return 0;
                int rows = Marshal.ReadInt32(buf);
                int n = 0;
                if (af == 2)
                {
                    // MIB_TCPROW_OWNER_PID: state, localAddr, localPort, remoteAddr, remotePort, pid (6 x 4 bytes)
                    for (int i = 0; i < rows; i++)
                    {
                        var row = buf + 4 + i * 24;
                        int state = Marshal.ReadInt32(row);
                        uint remote = (uint)Marshal.ReadInt32(row + 12);
                        int owner = Marshal.ReadInt32(row + 20);
                        if (owner == pid && state == 5 && (remote & 0xFF) != 127) n++;
                    }
                }
                else
                {
                    // MIB_TCP6ROW_OWNER_PID: localAddr[16], localScope, localPort, remoteAddr[16], remoteScope, remotePort, state, pid
                    for (int i = 0; i < rows; i++)
                    {
                        var row = buf + 4 + i * 56;
                        int state = Marshal.ReadInt32(row + 48);
                        int owner = Marshal.ReadInt32(row + 52);
                        bool loopback = true;
                        for (int b = 0; b < 15; b++) if (Marshal.ReadByte(row + 24 + b) != 0) { loopback = false; break; }
                        if (Marshal.ReadByte(row + 24 + 15) != 1) loopback = false;
                        if (owner == pid && state == 5 && !loopback) n++;
                    }
                }
                return n;
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
        }
    }
}
