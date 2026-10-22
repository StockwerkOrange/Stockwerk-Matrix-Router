#!/bin/sh
# Builds a test copy (IPv4-only patch for hosts without IPv6) and runs RedirectTest.
# Needs: .NET 8 SDK. The shipped build is NOT patched.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
cp -r "$HERE/libomtnet" "$HERE/Program.cs" "$HERE/4OutOMTMatrix.csproj" "$HERE/Panel.cs" "$HERE/panel.html" "$T/"
if ! python3 -c "import socket;socket.socket(socket.AF_INET6)" 2>/dev/null; then
  sed -i 's/AddressFamily.InterNetworkV6, SocketType/AddressFamily.InterNetwork, SocketType/; /IPv6Only, false/d; s/IPAddress.IPv6Any, i/IPAddress.Any, i/' "$T/libomtnet/src/OMTSend.cs"
  sed -i 's/new Socket(AddressFamily.InterNetworkV6, SocketType.Stream/new Socket(AddressFamily.InterNetwork, SocketType.Stream/; /IPv6Only, false/d; s/s.BeginConnect(next, port/s.BeginConnect(next.IsIPv4MappedToIPv6 ? next.MapToIPv4() : next, port/' "$T/libomtnet/src/OMTMultiConnectSocket.cs"
fi
# Discovery via the OMT Discovery Server (hosted by the test) instead of Avahi/mDNS: deterministic in containers.
sed -i 's/instance = new linux.OMTDiscoveryAvahi();/instance = new OMTDiscovery();/' "$T/libomtnet/src/OMTDiscovery.cs"
export OMT_STORAGE_PATH="$T/omt"
mkdir -p "$OMT_STORAGE_PATH"
echo '<Settings><DiscoveryServer>omt://127.0.0.1:6399</DiscoveryServer></Settings>' > "$OMT_STORAGE_PATH/settings.xml"
mkdir -p "$T/test" && cp "$HERE/test/RedirectTest.cs" "$T/test/"
cat > "$T/test/RedirectTest.csproj" <<P
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><AllowUnsafeBlocks>true</AllowUnsafeBlocks><InvariantGlobalization>true</InvariantGlobalization><NoWarn>\$(NoWarn);CS0168;CS0219;CS0162;CS0414;CS0649;CS0169;CA1416;SYSLIB0011;SYSLIB0014</NoWarn></PropertyGroup>
  <ItemGroup><Compile Include="../libomtnet/src/**/*.cs" /></ItemGroup>
</Project>
P
(cd "$T" && dotnet build -c Release -nologo -v q >/dev/null)
(cd "$T/test" && dotnet build -c Release -nologo -v q >/dev/null)
dotnet "$T/test/bin/Release/net8.0/RedirectTest.dll" "$T/bin/Release/net8.0/4OutOMTMatrix.dll"
