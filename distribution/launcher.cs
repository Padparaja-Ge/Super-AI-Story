using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
[assembly: AssemblyTitle("SAS · Super AI Story")]
[assembly: AssemblyDescription("Super AI Story launcher")]
[assembly: AssemblyCompany("Padparaja-Ge and Wenzeslaus-first")]
[assembly: AssemblyCopyright("Copyright 2026 Padparaja. Developers: Padparaja-Ge and Wenzeslaus-first.")]
[assembly: AssemblyVersion("0.9.4.0")]
[assembly: AssemblyFileVersion("0.9.4.0")]
static class SasLauncher {
 static string Quote(string value) {
  var text=new StringBuilder("\""); int slashes=0;
  foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='"'){text.Append('\\',slashes*2+1).Append(c);slashes=0;continue;}text.Append('\\',slashes).Append(c);slashes=0;}
  return text.Append('\\',slashes*2).Append('"').ToString();
 }
 [STAThread] static int Main(string[] args) {
  try {
   string root=AppDomain.CurrentDomain.BaseDirectory;
   string app=Path.Combine(root,"app","SAS.exe");
   if(!File.Exists(app))throw new Exception("Не найдена папка app. Запустите Start-SAS.cmd или Repair-SAS.cmd из этой папки.");
   var start=new ProcessStartInfo(app){UseShellExecute=false,WorkingDirectory=root,CreateNoWindow=false};
   var arguments=new StringBuilder();foreach(string arg in args){if(arguments.Length>0)arguments.Append(' ');arguments.Append(Quote(arg));}start.Arguments=arguments.ToString();
   start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
   start.EnvironmentVariables["PORTABLE_EXECUTABLE_DIR"]=root.TrimEnd(Path.DirectorySeparatorChar);
   if(String.IsNullOrEmpty(start.EnvironmentVariables["SAS_LLAMA_DIR"]))start.EnvironmentVariables["SAS_LLAMA_DIR"]=Path.Combine(root,"engines","llama");
   if(String.IsNullOrEmpty(start.EnvironmentVariables["SAS_SPEECH_BUNDLE_DIR"]))start.EnvironmentVariables["SAS_SPEECH_BUNDLE_DIR"]=Path.Combine(root,"engines","speech");
   using(var process=Process.Start(start)){process.WaitForExit();return process.ExitCode;}
  }catch(Exception error){MessageBox.Show(error.Message,"SAS — запуск",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
 }
}
