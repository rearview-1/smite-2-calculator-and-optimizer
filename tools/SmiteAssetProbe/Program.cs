using System.IO;
using System.Linq;
using System.Text;
using CUE4Parse.Compression;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.AssetRegistry;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Pak;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;
using Newtonsoft.Json;
using Serilog;

var archiveDirectory = args.FirstOrDefault(arg => !arg.StartsWith("--", StringComparison.Ordinal)) ??
                       @"C:\Program Files (x86)\Steam\steamapps\common\SMITE 2\Windows\Hemingway\Content\Paks";
var defaultGameVersion = EGame.GAME_UE5_4;

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Debug()
    .WriteTo.Console(outputTemplate: "[{Level:u3}] {Message:lj}{NewLine}")
    .CreateLogger();

if (args.Contains("--version-sweep"))
{
    await SweepVersionsAsync(archiveDirectory);
    return;
}

if (args.Contains("--asset-registry"))
{
    DumpAssetRegistry(archiveDirectory, defaultGameVersion, ParseQueries(args));
    return;
}

if (args.Contains("--list-files"))
{
    ListMountedFiles(archiveDirectory, defaultGameVersion, ParseQueries(args));
    return;
}

if (args.Contains("--raw-dump"))
{
    // Dumps the full raw asset bytes of matching files as hex, one per .hex file.
    var rawQueries = args
        .Where(arg => arg.StartsWith("--query=", StringComparison.OrdinalIgnoreCase))
        .Select(arg => arg["--query=".Length..].Trim())
        .Where(arg => !string.IsNullOrWhiteSpace(arg))
        .ToArray();
    DumpRawAssets(archiveDirectory, defaultGameVersion, rawQueries);
    return;
}

if (args.Contains("--anim-timings"))
{
    // Parse queries directly — if user gave none, use an empty array (no filter beyond /Animations/).
    var rawQueries = args
        .Where(arg => arg.StartsWith("--query=", StringComparison.OrdinalIgnoreCase))
        .Select(arg => arg["--query=".Length..].Trim())
        .Where(arg => !string.IsNullOrWhiteSpace(arg))
        .ToArray();
    DumpAnimTimings(archiveDirectory, defaultGameVersion, rawQueries);
    return;
}

if (args.Contains("--list-pak-files"))
{
    ListPakFiles(archiveDirectory, defaultGameVersion, ParseQueries(args));
    return;
}

if (args.Contains("--pak-asset-registry"))
{
    DumpPakAssetRegistry(archiveDirectory, defaultGameVersion, ParseQueries(args));
    return;
}

var packagePaths = ParsePackagePaths(args);

var outputDirectory = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "out"));
Directory.CreateDirectory(outputDirectory);

Console.WriteLine($"Archive directory: {archiveDirectory}");
Console.WriteLine($"Output directory: {outputDirectory}");

ZlibHelper.Initialize();
OodleHelper.Initialize();

var provider = new DefaultFileProvider(
    archiveDirectory,
    SearchOption.TopDirectoryOnly,
    true,
    new VersionContainer(defaultGameVersion));
provider.MappingsContainer = new LocalTypeMappingsProvider();
provider.ReadScriptData = true;

provider.Initialize();
var mounted = provider.Mount();
provider.PostMount();

Console.WriteLine($"Mounted containers: {mounted}");
Console.WriteLine($"Mounted files: {provider.Files.Count}");

foreach (var packagePath in packagePaths)
{
    Console.WriteLine($"\n=== {packagePath} ===");

    var directMatches = provider.Files.Values
        .Where(file => file.Path.Contains(packagePath, StringComparison.OrdinalIgnoreCase))
        .ToArray();
    Console.WriteLine($"Direct file matches: {directMatches.Length}");
    foreach (var match in directMatches.Take(5))
    {
        Console.WriteLine($" - {match.Path}");
    }

    var package = default(CUE4Parse.UE4.Assets.IPackage);
    Exception? loadException = null;

    try
    {
        package = provider.LoadPackage(packagePath);
    }
    catch (Exception ex)
    {
        loadException = ex;
    }

    if (package is null && directMatches.Length > 0)
    {
        try
        {
            package = provider.LoadPackage(directMatches[0]);
            loadException = null;
        }
        catch (Exception ex)
        {
            loadException = ex;
        }
    }

    if (package is null)
    {
        Console.WriteLine("Package load failed.");
        if (loadException is not null)
        {
            Console.WriteLine($"{loadException.GetType().FullName}: {loadException.Message}");
        }
        continue;
    }

    var rawAssetBytes = provider.SaveAsset(directMatches[0]);
    DumpPackageStructure(package, outputDirectory, packagePath, rawAssetBytes);
}

static string[] ParseQueries(string[] args)
{
    var queries = args
        .Where(arg => arg.StartsWith("--query=", StringComparison.OrdinalIgnoreCase))
        .Select(arg => arg["--query=".Length..].Trim())
        .Where(arg => !string.IsNullOrWhiteSpace(arg))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    return queries.Length > 0
        ? queries
        : new[]
        {
            "Loki",
            "HydrasLament",
            "TitansBane",
            "SerpentSpear",
            "A02",
        };
}

static string[] ParsePackagePaths(string[] args)
{
    var packagePaths = args
        .Where(arg => arg.StartsWith("--package=", StringComparison.OrdinalIgnoreCase))
        .Select(arg => arg["--package=".Length..].Trim())
        .Where(arg => !string.IsNullOrWhiteSpace(arg))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    return packagePaths.Length > 0
        ? packagePaths
        : new[]
        {
            "Hemingway/Content/Characters/GODS/Loki/CT_Loki_Stats",
            "Hemingway/Content/Characters/GODS/Loki/Common/Abilities/Ability2/LevelConfigs/CT_Loki_A02_EffectValues",
            "Hemingway/Content/Characters/GODS/Loki/Common/Abilities/Ability2/GameplayEffects/GE_Loki_A02_Damage",
            "Hemingway/Content/Items_November2023/HydrasLament/EquipmentInfo_Item_HydrasLament",
            "Hemingway/Content/Items_November2023/HydrasLament/EquipmentItem_Item_HydrasLament",
            "Hemingway/Content/Items_November2023/HydrasLament/GE_Items_HydrasLament",
            "Hemingway/Content/Items_November2023/HydrasLament/GameplayEffects/GE_Items_HydrasLament_Tracker",
            "Hemingway/Content/Items_November2023/HydrasLament/LevelConfig/LC_HydrasLament_1",
            "Hemingway/Content/Items_November2023/SerpentSpear/EquipmentInfo_Item_SerpentSpear",
            "Hemingway/Content/Items_November2023/SerpentSpear/EquipmentItem_Item_SerpentSpear",
            "Hemingway/Content/Items_November2023/SerpentSpear/GE_Items_SerpentSpear",
            "Hemingway/Content/Items_November2023/SerpentSpear/GE_Items_TitansBane_Shattering",
        };
}

static void DumpAssetRegistry(string archiveDirectory, EGame gameVersion, string[] queries)
{
    var outputDirectory = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "out"));
    Directory.CreateDirectory(outputDirectory);

    Console.WriteLine($"Archive directory: {archiveDirectory}");
    Console.WriteLine($"Output directory: {outputDirectory}");
    Console.WriteLine($"Game version: {gameVersion}");
    Console.WriteLine($"Queries: {string.Join(", ", queries)}");

    ZlibHelper.Initialize();
    OodleHelper.Initialize();

    var provider = new DefaultFileProvider(
        archiveDirectory,
        SearchOption.TopDirectoryOnly,
        true,
        new VersionContainer(gameVersion));
    provider.MappingsContainer = new LocalTypeMappingsProvider();
    provider.ReadScriptData = true;

    provider.Initialize();
    provider.Mount();
    provider.PostMount();

    var registryEntry = provider.Files.Values
        .FirstOrDefault(file => file.Path.EndsWith("AssetRegistry.bin", StringComparison.OrdinalIgnoreCase));

    if (registryEntry is null)
    {
        Console.WriteLine("AssetRegistry.bin not found.");
        return;
    }

    Console.WriteLine($"Registry entry: {registryEntry.Path}");

    using var archive = registryEntry.CreateReader();
    var registry = new FAssetRegistryState(archive);
    var matches = registry.PreallocatedAssetDataBuffers
        .Where(asset => MatchesQuery(asset.ObjectPath, queries) ||
                        MatchesQuery(asset.AssetClass.Text, queries) ||
                        asset.TagsAndValues.Any(tag => MatchesQuery(tag.Key.Text, queries) || MatchesQuery(tag.Value, queries)))
        .OrderBy(asset => asset.ObjectPath, StringComparer.OrdinalIgnoreCase)
        .ToArray();

    Console.WriteLine($"Registry assets: {registry.PreallocatedAssetDataBuffers.Length}");
    Console.WriteLine($"Query matches: {matches.Length}");

    var projected = matches
        .Select(asset => new
        {
            objectPath = asset.ObjectPath,
            packageName = asset.PackageName.Text,
            packagePath = asset.PackagePath.Text,
            assetName = asset.AssetName.Text,
            assetClass = asset.AssetClass.Text,
            tags = asset.TagsAndValues
                .OrderBy(tag => tag.Key.Text, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(tag => tag.Key.Text, tag => tag.Value),
        })
        .ToArray();

    var outputPath = Path.Combine(outputDirectory, "asset-registry-query-results.json");
    File.WriteAllText(outputPath, JsonConvert.SerializeObject(projected, Formatting.Indented));
    Console.WriteLine($"Wrote {outputPath}");

    foreach (var asset in projected.Take(25))
    {
        Console.WriteLine($"\n{asset.objectPath} [{asset.assetClass}]");
        foreach (var tag in asset.tags.Take(12))
        {
            Console.WriteLine($"  {tag.Key}: {tag.Value}");
        }
    }
}

static void ListMountedFiles(string archiveDirectory, EGame gameVersion, string[] queries)
{
    ZlibHelper.Initialize();
    OodleHelper.Initialize();

    var provider = new DefaultFileProvider(
        archiveDirectory,
        SearchOption.TopDirectoryOnly,
        true,
        new VersionContainer(gameVersion));
    provider.MappingsContainer = new LocalTypeMappingsProvider();
    provider.ReadScriptData = true;

    provider.Initialize();
    provider.Mount();
    provider.PostMount();

    var matches = provider.Files.Values
        .Where(file => MatchesQuery(file.Path, queries))
        .OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase)
        .ToArray();

    Console.WriteLine($"Mounted files: {provider.Files.Count}");
    Console.WriteLine($"Query matches: {matches.Length}");

    foreach (var match in matches)
    {
        Console.WriteLine(match.Path);
    }
}

static bool MatchesQuery(string? value, string[] queries)
{
    if (string.IsNullOrWhiteSpace(value))
    {
        return false;
    }

    return queries.Any(query => value.Contains(query, StringComparison.OrdinalIgnoreCase));
}

static void DumpPackageStructure(IPackage package, string outputDirectory, string packagePath, byte[] rawAssetBytes)
{
    Console.WriteLine($"Package type: {package.GetType().FullName}");
    Console.WriteLine($"Name count: {package.NameMap.Length}");
    Console.WriteLine($"Import count: {package.ImportMapLength}");
    Console.WriteLine($"Export count: {package.ExportMapLength}");

    var safeName = packagePath.Replace('/', '_');

    switch (package)
    {
        case IoPackage ioPackage:
        {
            var structure = new
            {
                packageType = "IoPackage",
                packageName = ioPackage.Name,
                rawAssetLength = rawAssetBytes.Length,
                summary = new
                {
                    ioPackage.Summary.NameCount,
                    ioPackage.Summary.NameOffset,
                    ioPackage.Summary.ImportCount,
                    ioPackage.Summary.ImportOffset,
                    ioPackage.Summary.ExportCount,
                    ioPackage.Summary.ExportOffset,
                    ioPackage.Summary.TotalHeaderSize,
                    ioPackage.Summary.PackageFlags,
                    ioPackage.Summary.bUnversioned,
                },
                names = ioPackage.NameMap.Select(name => name.Name).ToArray(),
                imports = ioPackage.ImportMap.Select(index => new
                {
                    path = ioPackage.ResolveObjectIndex(index)?.GetPathName(),
                    fullName = ioPackage.ResolveObjectIndex(index)?.GetFullName(),
                    type = index.Type.ToString(),
                    value = index.Value,
                    raw = index.TypeAndId,
                }).ToArray(),
                exports = ioPackage.ExportMap.Select((export, index) => new
                {
                    index,
                    objectName = ioPackage.CreateFNameFromMappedName(export.ObjectName).Text,
                    cookedSerialOffset = export.CookedSerialOffset,
                    cookedSerialSize = export.CookedSerialSize,
                    classIndex = DescribeIoObjectIndex(ioPackage, export.ClassIndex),
                    outerIndex = DescribeIoObjectIndex(ioPackage, export.OuterIndex),
                    superIndex = DescribeIoObjectIndex(ioPackage, export.SuperIndex),
                    serialScan = ScanIoExport(rawAssetBytes, ioPackage, export),
                }).ToArray(),
            };

            foreach (var export in structure.exports.Take(12))
            {
                Console.WriteLine($"[{export.index}] {export.objectName} size={export.cookedSerialSize}");
            }

            var outputPath = Path.Combine(outputDirectory, $"{safeName}.structure.json");
            File.WriteAllText(outputPath, JsonConvert.SerializeObject(structure, Formatting.Indented));
            Console.WriteLine($"Wrote {outputPath}");
            break;
        }
        case Package standardPackage:
        {
            var structure = new
            {
                packageType = "Package",
                packageName = standardPackage.Name,
                rawAssetLength = rawAssetBytes.Length,
                summary = new
                {
                    standardPackage.Summary.NameCount,
                    standardPackage.Summary.NameOffset,
                    standardPackage.Summary.ImportCount,
                    standardPackage.Summary.ImportOffset,
                    standardPackage.Summary.ExportCount,
                    standardPackage.Summary.ExportOffset,
                    standardPackage.Summary.TotalHeaderSize,
                    standardPackage.Summary.PackageFlags,
                    standardPackage.Summary.bUnversioned,
                    standardPackage.Summary.AssetRegistryDataOffset,
                },
                names = standardPackage.NameMap.Select(name => name.Name).ToArray(),
                imports = standardPackage.ImportMap.Select((import, index) => new
                {
                    index,
                    classPackage = import.ClassPackage.Text,
                    className = import.ClassName.Text,
                    objectName = import.ObjectName.Text,
                    outerIndex = import.OuterIndex.Index,
                }).ToArray(),
                exports = standardPackage.ExportMap.Select((export, index) => new
                {
                    index,
                    objectName = export.ObjectName.Text,
                    serialOffset = export.SerialOffset,
                    serialSize = export.SerialSize,
                    classIndex = DescribePackageIndex(standardPackage, export.ClassIndex),
                    superIndex = DescribePackageIndex(standardPackage, export.SuperIndex),
                    outerIndex = DescribePackageIndex(standardPackage, export.OuterIndex),
                    serialScan = ScanStandardExport(rawAssetBytes, export.SerialOffset, export.SerialSize),
                }).ToArray(),
            };

            foreach (var export in structure.exports.Take(12))
            {
                Console.WriteLine($"[{export.index}] {export.objectName} size={export.serialSize} classIndex={export.classIndex}");
            }

            var outputPath = Path.Combine(outputDirectory, $"{safeName}.structure.json");
            File.WriteAllText(outputPath, JsonConvert.SerializeObject(structure, Formatting.Indented));
            Console.WriteLine($"Wrote {outputPath}");
            break;
        }
        default:
            Console.WriteLine("Unknown package type; no structural dump written.");
            break;
    }

    try
    {
        var exports = package.GetExports().ToArray();
        Console.WriteLine($"Deserialized exports: {exports.Length}");

        var exportsOutputPath = Path.Combine(outputDirectory, $"{safeName}.exports.json");
        File.WriteAllText(exportsOutputPath, JsonConvert.SerializeObject(exports, Formatting.Indented));
        Console.WriteLine($"Wrote {exportsOutputPath}");

        var pseudoCode = exports
            .OfType<UClass>()
            .Select(export =>
            {
                try
                {
                    return new
                    {
                        export.Name,
                        pseudoCode = export.DecompileBlueprintToPseudo(package.Mappings ?? new LocalTypeMappingsProvider().MappingsForGame!),
                    };
                }
                catch (Exception ex)
                {
                    return new
                    {
                        export.Name,
                        pseudoCode = $"// Decompile failed: {ex.GetType().FullName}: {ex.Message}\n// StackTrace:\n// {ex.StackTrace?.Replace("\n", "\n// ")}",
                    };
                }
            })
            .Where(entry => !string.IsNullOrWhiteSpace(entry.pseudoCode))
            .ToArray();

        if (pseudoCode.Length > 0)
        {
            var pseudoOutputPath = Path.Combine(outputDirectory, $"{safeName}.pseudo.cpp");
            var pseudoText = string.Join(
                $"{Environment.NewLine}{Environment.NewLine}// ====={Environment.NewLine}{Environment.NewLine}",
                pseudoCode.Select(entry => $"// {entry.Name}{Environment.NewLine}{entry.pseudoCode}"));
            File.WriteAllText(pseudoOutputPath, pseudoText);
            Console.WriteLine($"Wrote {pseudoOutputPath}");
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Export deserialization failed: {ex.GetType().FullName}: {ex.Message}");
    }
}

static object ScanIoExport(byte[] rawAssetBytes, IoPackage package, CUE4Parse.UE4.IO.Objects.FExportMapEntry export)
{
    var exportDataOffset = rawAssetBytes.Length - package.ExportMap.Sum(entry => (int) entry.CookedSerialSize);
    var serialOffset = exportDataOffset + (int) export.CookedSerialOffset;
    return ScanByteWindow(rawAssetBytes, serialOffset, (int) export.CookedSerialSize);
}

static object ScanStandardExport(byte[] rawAssetBytes, long serialOffset, long serialSize)
{
    return ScanByteWindow(rawAssetBytes, (int) serialOffset, (int) serialSize);
}

static object ScanByteWindow(byte[] rawAssetBytes, int offset, int size)
{
    if (offset < 0 || size <= 0 || offset + size > rawAssetBytes.Length)
    {
        return new
        {
            offset,
            size,
            error = "out_of_range",
        };
    }

    var slice = new byte[size];
    Array.Copy(rawAssetBytes, offset, slice, 0, size);

    var floats = Enumerable.Range(0, Math.Max(0, size - 3))
        .Where(index => index % 4 == 0)
        .Select(index => new
        {
            offset = index,
            value = BitConverter.ToSingle(slice, index),
        })
        .Where(entry => !float.IsNaN(entry.value) && !float.IsInfinity(entry.value) && Math.Abs(entry.value) <= 100000f)
        .Take(64)
        .ToArray();

    var plausibleFloats = Enumerable.Range(0, Math.Max(0, size - 3))
        .Select(index => new
        {
            offset = index,
            value = BitConverter.ToSingle(slice, index),
        })
        .Where(entry => !float.IsNaN(entry.value) &&
                        !float.IsInfinity(entry.value) &&
                        Math.Abs(entry.value) >= 0.01f &&
                        Math.Abs(entry.value) <= 10000f &&
                        Math.Abs(entry.value - MathF.Round(entry.value, 2)) < 0.0005f)
        .Take(128)
        .ToArray();

    var ints = Enumerable.Range(0, Math.Max(0, size - 3))
        .Where(index => index % 4 == 0)
        .Select(index => new
        {
            offset = index,
            value = BitConverter.ToInt32(slice, index),
        })
        .Where(entry => Math.Abs((long) entry.value) <= 100000)
        .Take(64)
        .ToArray();

    var asciiStrings = ExtractAsciiStrings(slice)
        .Take(64)
        .ToArray();

    var utf16Strings = ExtractUtf16LeStrings(slice)
        .Take(64)
        .ToArray();

    return new
    {
        offset,
        size,
        firstBytesHex = Convert.ToHexString(slice.Take(Math.Min(64, slice.Length)).ToArray()),
        floats,
        plausibleFloats,
        ints,
        asciiStrings,
        utf16Strings,
    };
}

static object DescribeIoObjectIndex(IoPackage package, CUE4Parse.UE4.IO.Objects.FPackageObjectIndex index)
{
    var resolved = package.ResolveObjectIndex(index);
    return new
    {
        type = index.Type.ToString(),
        value = index.Value,
        raw = index.TypeAndId,
        path = resolved?.GetPathName(),
        fullName = resolved?.GetFullName(),
    };
}

static object DescribePackageIndex(IPackage package, FPackageIndex? index)
{
    if (index is null)
    {
        return new
        {
            index = 0,
            kind = "Null",
            path = (string?) null,
            fullName = (string?) null,
        };
    }

    var resolved = package.ResolvePackageIndex(index);
    return new
    {
        index = index.Index,
        kind = index.IsNull ? "Null" : index.IsImport ? "Import" : index.IsExport ? "Export" : "Unknown",
        path = resolved?.GetPathName(),
        fullName = resolved?.GetFullName(),
    };
}

static IEnumerable<object> ExtractAsciiStrings(byte[] slice, int minimumLength = 4)
{
    for (var i = 0; i < slice.Length;)
    {
        if (!IsPrintableAscii(slice[i]))
        {
            i++;
            continue;
        }

        var start = i;
        while (i < slice.Length && IsPrintableAscii(slice[i]))
        {
            i++;
        }

        var length = i - start;
        if (length >= minimumLength)
        {
            yield return new
            {
                offset = start,
                value = Encoding.ASCII.GetString(slice, start, length),
            };
        }
    }
}

static IEnumerable<object> ExtractUtf16LeStrings(byte[] slice, int minimumLength = 4)
{
    for (var i = 0; i < slice.Length - 1;)
    {
        if (!IsPrintableAscii(slice[i]) || slice[i + 1] != 0)
        {
            i++;
            continue;
        }

        var start = i;
        var builder = new StringBuilder();

        while (i < slice.Length - 1 && IsPrintableAscii(slice[i]) && slice[i + 1] == 0)
        {
            builder.Append((char) slice[i]);
            i += 2;
        }

        if (builder.Length >= minimumLength)
        {
            yield return new
            {
                offset = start,
                value = builder.ToString(),
            };
        }
    }
}

static bool IsPrintableAscii(byte value) => value is >= 32 and <= 126;

static IEnumerable<PakFileReader> OpenPakReaders(string archiveDirectory, EGame gameVersion)
{
    var pakFiles = Directory
        .EnumerateFiles(archiveDirectory, "*.pak", SearchOption.TopDirectoryOnly)
        .OrderBy(path => path, StringComparer.OrdinalIgnoreCase);

    foreach (var pakFile in pakFiles)
    {
        var reader = new PakFileReader(pakFile, new VersionContainer(gameVersion));
        reader.Mount(StringComparer.OrdinalIgnoreCase);
        yield return reader;
    }
}

static void ListPakFiles(string archiveDirectory, EGame gameVersion, string[] queries)
{
    foreach (var pakReader in OpenPakReaders(archiveDirectory, gameVersion))
    {
        using (pakReader)
        {
            var matches = pakReader.Files.Values
                .Where(file => MatchesQuery(file.Path, queries))
                .OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase)
                .ToArray();

            Console.WriteLine($"\n=== {pakReader.Name} ===");
            Console.WriteLine($"Pak files: {pakReader.FileCount}");
            Console.WriteLine($"Query matches: {matches.Length}");

            foreach (var match in matches.Take(100))
            {
                Console.WriteLine(match.Path);
            }
        }
    }
}

static void DumpPakAssetRegistry(string archiveDirectory, EGame gameVersion, string[] queries)
{
    var outputDirectory = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "out"));
    Directory.CreateDirectory(outputDirectory);

    foreach (var pakReader in OpenPakReaders(archiveDirectory, gameVersion))
    {
        using (pakReader)
        {
            var registryFile = pakReader.Files.Values
                .FirstOrDefault(file => file.Path.EndsWith("AssetRegistry.bin", StringComparison.OrdinalIgnoreCase));

            if (registryFile is null)
            {
                Console.WriteLine($"{pakReader.Name}: AssetRegistry.bin not found");
                continue;
            }

            Console.WriteLine($"{pakReader.Name}: found {registryFile.Path}");

            var bytes = registryFile.Read();
            using var archive = new FByteArchive(registryFile.Path, bytes, new VersionContainer(gameVersion));
            var registry = new FAssetRegistryState(archive);
            var matches = registry.PreallocatedAssetDataBuffers
                .Where(asset => MatchesQuery(asset.ObjectPath, queries) ||
                                MatchesQuery(asset.AssetClass.Text, queries) ||
                                asset.TagsAndValues.Any(tag => MatchesQuery(tag.Key.Text, queries) || MatchesQuery(tag.Value, queries)))
                .OrderBy(asset => asset.ObjectPath, StringComparer.OrdinalIgnoreCase)
                .ToArray();

            Console.WriteLine($"Registry assets: {registry.PreallocatedAssetDataBuffers.Length}");
            Console.WriteLine($"Query matches: {matches.Length}");

            var safePakName = Path.GetFileNameWithoutExtension(pakReader.Name);
            var outputPath = Path.Combine(outputDirectory, $"{safePakName}-asset-registry-query-results.json");
            var projected = matches
                .Select(asset => new
                {
                    objectPath = asset.ObjectPath,
                    packageName = asset.PackageName.Text,
                    packagePath = asset.PackagePath.Text,
                    assetName = asset.AssetName.Text,
                    assetClass = asset.AssetClass.Text,
                    tags = asset.TagsAndValues
                        .OrderBy(tag => tag.Key.Text, StringComparer.OrdinalIgnoreCase)
                        .ToDictionary(tag => tag.Key.Text, tag => tag.Value),
                })
                .ToArray();

            File.WriteAllText(outputPath, JsonConvert.SerializeObject(projected, Formatting.Indented));
            Console.WriteLine($"Wrote {outputPath}");

            foreach (var asset in projected.Take(20))
            {
                Console.WriteLine($"\n{asset.objectPath} [{asset.assetClass}]");
                foreach (var tag in asset.tags.Take(10))
                {
                    Console.WriteLine($"  {tag.Key}: {tag.Value}");
                }
            }
        }
    }
}

static async Task SweepVersionsAsync(string archiveDirectory)
{
    var versions = new[]
    {
        EGame.GAME_UE5_0,
        EGame.GAME_UE5_1,
        EGame.GAME_UE5_2,
        EGame.GAME_UE5_3,
        EGame.GAME_UE5_4,
        EGame.GAME_UE5_5,
        EGame.GAME_UE5_6,
        EGame.GAME_UE5_7,
        EGame.GAME_UE5_8,
        EGame.GAME_UE5_LATEST,
    };

    const string probePath = "Hemingway/Content/Characters/GODS/Loki/Common/Abilities/Ability2/LevelConfigs/CT_Loki_A02_EffectValues";

    ZlibHelper.Initialize();
    OodleHelper.Initialize();

    foreach (var version in versions)
    {
        Console.WriteLine($"\n=== Version {version} ===");
        try
        {
            var provider = new DefaultFileProvider(
                archiveDirectory,
                SearchOption.TopDirectoryOnly,
                true,
                new VersionContainer(version));

            provider.Initialize();
            var mounted = provider.Mount();
            provider.PostMount();

            Console.WriteLine($"Mounted containers: {mounted}");
            Console.WriteLine($"Mounted files: {provider.Files.Count}");

            var matches = provider.Files.Values
                .Where(file => file.Path.Contains(probePath, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            Console.WriteLine($"Direct file matches: {matches.Length}");

            if (matches.Length == 0)
            {
                continue;
            }

            var package = provider.LoadPackage(matches[0]);
            var exports = package.GetExports().ToArray();
            Console.WriteLine($"SUCCESS: exports={exports.Length}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"{ex.GetType().FullName}: {ex.Message}");
        }

        await Task.Yield();
    }
}

static void DumpRawAssets(string archiveDirectory, EGame gameVersion, string[] queries)
{
    ZlibHelper.Initialize();
    OodleHelper.Initialize();

    var provider = new DefaultFileProvider(
        archiveDirectory,
        SearchOption.TopDirectoryOnly,
        true,
        new VersionContainer(gameVersion));
    provider.MappingsContainer = new LocalTypeMappingsProvider();
    provider.ReadScriptData = true;
    provider.Initialize();
    provider.Mount();
    provider.PostMount();

    var outputDirectory = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "out"));
    Directory.CreateDirectory(outputDirectory);

    var matches = provider.Files.Values
        .Where(file => file.Path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
        .Where(file => queries.Length == 0 || queries.All(q => file.Path.Contains(q, StringComparison.OrdinalIgnoreCase)))
        .OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase)
        .ToArray();

    Console.WriteLine($"Matches: {matches.Length}");
    int ok = 0, fail = 0;
    foreach (var file in matches)
    {
        try
        {
            var bytes = provider.SaveAsset(file);
            var safe = file.Path.Replace('/', '_').Replace('\\', '_');
            var outPath = Path.Combine(outputDirectory, $"{safe}.bin");
            File.WriteAllBytes(outPath, bytes);

            // Also emit a minimal structure.json alongside with enough metadata
            // for downstream scripts (name map, export list with offsets/sizes).
            var pkg = provider.LoadPackage(file);
            if (pkg is IoPackage ioPkg)
            {
                var structOut = new
                {
                    packageType = "IoPackage",
                    packageName = ioPkg.Name,
                    rawAssetLength = bytes.Length,
                    summary = new
                    {
                        ioPkg.Summary.NameCount,
                        ioPkg.Summary.NameOffset,
                        ioPkg.Summary.ImportCount,
                        ioPkg.Summary.ImportOffset,
                        ioPkg.Summary.ExportCount,
                        ioPkg.Summary.ExportOffset,
                        ioPkg.Summary.TotalHeaderSize,
                        ioPkg.Summary.PackageFlags,
                        ioPkg.Summary.bUnversioned,
                    },
                    names = ioPkg.NameMap.Select(n => n.Name).ToArray(),
                    exports = ioPkg.ExportMap.Select((e, i) => new
                    {
                        index = i,
                        objectName = ioPkg.CreateFNameFromMappedName(e.ObjectName).Text,
                        cookedSerialOffset = e.CookedSerialOffset,
                        cookedSerialSize = e.CookedSerialSize,
                    }).ToArray(),
                };
                File.WriteAllText(Path.Combine(outputDirectory, $"{safe}.structure.json"),
                    JsonConvert.SerializeObject(structOut, Formatting.Indented));
            }
            ok++;
            if (ok <= 8 || ok % 100 == 0)
                Console.WriteLine($"  {file.Path} ({bytes.Length} bytes)");
        }
        catch (Exception ex)
        {
            fail++;
            if (fail <= 3)
                Console.WriteLine($"  FAIL {file.Path}: {ex.GetType().Name}: {ex.Message}");
        }
    }
    Console.WriteLine($"ok={ok} fail={fail}");
}

static void DumpAnimTimings(string archiveDirectory, EGame gameVersion, string[] queries)
{
    ZlibHelper.Initialize();
    OodleHelper.Initialize();

    var provider = new DefaultFileProvider(
        archiveDirectory,
        SearchOption.TopDirectoryOnly,
        true,
        new VersionContainer(gameVersion));
    provider.MappingsContainer = new LocalTypeMappingsProvider();
    provider.ReadScriptData = true;
    provider.Initialize();
    provider.Mount();
    provider.PostMount();

    Console.WriteLine($"Mounted files: {provider.Files.Count}");

    var matches = provider.Files.Values
        .Where(file => file.Path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
        .Where(file => file.Path.Contains("/Animations/", StringComparison.OrdinalIgnoreCase))
        .Where(file => queries.Length == 0 || queries.All(q => file.Path.Contains(q, StringComparison.OrdinalIgnoreCase)))
        .OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase)
        .ToArray();

    Console.WriteLine($"Matching animation assets: {matches.Length}");

    var outputDirectory = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "out"));
    Directory.CreateDirectory(outputDirectory);

    var results = new List<object>();
    int processed = 0, succeeded = 0, skipped = 0;
    foreach (var file in matches)
    {
        processed++;
        try
        {
            // Read raw .uasset bytes — skip deserialization since the usmap gap prevents
            // reading AnimSequence properties. Scan the binary for the ACL TracksHeader
            // signature instead.
            var bytes = provider.SaveAsset(file);
            var timing = ScanForAclTiming(bytes);
            if (timing is null)
            {
                if (processed <= 8 || processed % 500 == 0)
                    Console.WriteLine($"  SKIP {file.Path}: no ACL TracksHeader found");
                skipped++;
                continue;
            }

            results.Add(new
            {
                path = file.Path,
                numSamples = timing.NumSamples,
                sampleRate = timing.SampleRate,
                durationSeconds = timing.DurationSeconds,
                signatureOffset = timing.Offset,
            });
            succeeded++;
        }
        catch (Exception ex)
        {
            skipped++;
            if (processed <= 5 || processed % 500 == 0)
                Console.WriteLine($"  skip {file.Path}: {ex.GetType().Name}: {ex.Message}");
        }
        if (processed % 500 == 0)
            Console.WriteLine($"  processed {processed}/{matches.Length} — ok={succeeded} skip={skipped}");
    }

    var outPath = Path.Combine(outputDirectory, "anim-timings.json");
    File.WriteAllText(outPath, JsonConvert.SerializeObject(results, Formatting.Indented));
    Console.WriteLine($"Wrote {outPath}");
    Console.WriteLine($"Total: processed={processed} ok={succeeded} skip={skipped}");
}

// ACL TracksHeader + RawBufferHeader byte-level decode. We can't deserialize SMITE 2's
// AnimSequence through CUE4Parse because AnimSequence properties are unmapped (no usmap).
// Instead we scan the raw .uasset bytes for the ACL TracksHeader signature.
//
// Layout at header start:
//   [+0]  RawBufferHeader.Size     uint
//   [+4]  RawBufferHeader.Hash     uint
//   [+8]  TracksHeader.Tag         uint   (ACL 2.x compressed_tracks magic = 0xAC11AC11)
//   [+12] TracksHeader.Version     ushort
//   [+14] AlgorithmType            byte
//   [+15] TrackType                byte
//   [+16] NumTracks                uint
//   [+20] NumSamples               uint
//   [+24] SampleRate               float
//
// So starting from the ACL tag offset `t`, SampleRate = bytes[t+16..t+19] (float)
// and NumSamples = bytes[t+12..t+15] (uint).
static AnimTimingInfo? ScanForAclTiming(byte[] bytes)
{
    // Little-endian signature 0xAC11AC11 -> 0x11 0xAC 0x11 0xAC
    for (int i = 0; i + 28 < bytes.Length; i++)
    {
        if (bytes[i] != 0x11 || bytes[i + 1] != 0xAC || bytes[i + 2] != 0x11 || bytes[i + 3] != 0xAC) continue;
        uint numSamples = BitConverter.ToUInt32(bytes, i + 12);
        float sampleRate = BitConverter.ToSingle(bytes, i + 16);
        if (numSamples == 0 || numSamples > 100_000) continue;
        if (sampleRate <= 0 || sampleRate > 1000 || float.IsNaN(sampleRate) || float.IsInfinity(sampleRate)) continue;
        return new AnimTimingInfo
        {
            NumSamples = numSamples,
            SampleRate = sampleRate,
            DurationSeconds = numSamples / sampleRate,
            Offset = i,
        };
    }
    return null;
}

sealed class AnimTimingInfo
{
    public uint NumSamples;
    public float SampleRate;
    public float DurationSeconds;
    public int Offset;
}

sealed class LocalTypeMappingsProvider : AbstractTypeMappingsProvider
{
    public override TypeMappings? MappingsForGame { get; protected set; } = BuildMappings();

    public override void Load(string path, StringComparer? comparer = null)
    {
        MappingsForGame = BuildMappings();
    }

    public override void Load(byte[] bytes, StringComparer? comparer = null)
    {
        MappingsForGame = BuildMappings();
    }

    public override void Reload()
    {
        MappingsForGame = BuildMappings();
    }

    private static TypeMappings BuildMappings()
    {
        var types = new Dictionary<string, Struct>(StringComparer.OrdinalIgnoreCase);
        var enums = new Dictionary<string, Dictionary<long, string>>(StringComparer.OrdinalIgnoreCase);
        var mappings = new TypeMappings(types, enums);

        types["RealCurve"] = new Struct(
            mappings,
            "RealCurve",
            null,
            new Dictionary<int, PropertyInfo>
            {
                [0] = new(0, "DefaultValue", new PropertyType("FloatProperty")),
                [1] = new(1, "PreInfinityExtrap", new PropertyType("ByteProperty")),
                [2] = new(2, "PostInfinityExtrap", new PropertyType("ByteProperty")),
            },
            3);

        types["SimpleCurveKey"] = new Struct(
            mappings,
            "SimpleCurveKey",
            null,
            new Dictionary<int, PropertyInfo>
            {
                [0] = new(0, "Time", new PropertyType("FloatProperty")),
                [1] = new(1, "Value", new PropertyType("FloatProperty")),
            },
            2);

        types["SimpleCurve"] = new Struct(
            mappings,
            "SimpleCurve",
            "RealCurve",
            new Dictionary<int, PropertyInfo>
            {
                [0] = new(0, "InterpMode", new PropertyType("ByteProperty")),
                [1] = new(1, "Keys", new PropertyType("ArrayProperty", innerType: new PropertyType("StructProperty", structType: "SimpleCurveKey"))),
            },
            2);

        return mappings;
    }
}
