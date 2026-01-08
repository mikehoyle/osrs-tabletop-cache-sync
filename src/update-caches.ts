import "dotenv/config";
import {
    S3Client,
    PutObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import AdmZip from "adm-zip";
import * as fs from "fs";
import * as path from "path";

// --- Configuration ---
const R2_BUCKET = process.env.R2_BUCKET_NAME || "osrs-caches";
const R2_PUBLIC_URL = "https://caches.osrstabletop.com";
const OPENRS2_DOMAIN = "https://archive.openrs2.org";
const TEMP_DIR = "./temp_cache_download";

// Check for required environment variables
if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error("Error: Missing R2 environment variables. Please check your .env file.");
    process.exit(1);
}

// Initialize S3 Client for Cloudflare R2
const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// --- Type Definitions ---
interface OpenRS2Cache {
    id: number;
    scope: string;
    game: string;
    environment: string;
    language: string;
    builds: { major: number; minor: number | null }[];
    timestamp: string;
    size: number;
}

interface R2CacheManifestItem {
    name: string;
    game: string;
    environment: string;
    revision: number;
    timestamp: string;
    size: number;
}

// --- Main Logic ---
async function main() {
    try {
        console.log("Starting OSRS Cache Sync...");

        // 1. Fetch current R2 Manifest
        const r2Manifest = await fetchR2Manifest();
        console.log(`Current R2 Manifest has ${r2Manifest.length} entries.`);

        // 2. Fetch OpenRS2 List
        console.log("Fetching OpenRS2 cache list...");
        const openRs2Caches = await fetchOpenRS2Caches();

        // 3. Determine if we need to update
        if (openRs2Caches.length === 0) {
            console.log("No valid caches found on OpenRS2.");
            return;
        }

        const latestCache = openRs2Caches[0];
        const latestCacheDirName = getCacheDirName(latestCache);
        const alreadyExists = r2Manifest.some((c) => c.name === latestCacheDirName);

        if (alreadyExists) {
            console.log(`Latest cache (${latestCacheDirName}) is already in R2. Exiting.`);
            return;
        }

        // 4. Download and Process the new cache
        console.log(`New cache found: ${latestCacheDirName}. Downloading...`);

        // Ensure temp dir exists and is empty
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        fs.mkdirSync(TEMP_DIR);

        const localCachePath = path.join(TEMP_DIR, latestCacheDirName);
        fs.mkdirSync(localCachePath);

        // Download and extract zip
        await downloadAndExtractCache(latestCache, localCachePath);

        // Fetch and save keys.json (XTEAs)
        await saveXteas(latestCache, localCachePath);

        // Create info.json for the cache dir
        fs.writeFileSync(
            path.join(localCachePath, "info.json"),
            JSON.stringify(latestCache, null, 2)
        );

        // 5. Upload files to R2
        console.log(`Uploading ${latestCacheDirName} to R2...`);
        await uploadDirectory(localCachePath, `caches/${latestCacheDirName}`);

        // 6. Update Manifest List
        const newManifestEntry: R2CacheManifestItem = {
            name: latestCacheDirName,
            game: latestCache.game,
            environment: latestCache.environment,
            revision: latestCache.builds[0].major,
            timestamp: latestCache.timestamp,
            size: latestCache.size,
        };

        // Add new, sort desc by revision/date
        const updatedManifest = [newManifestEntry, ...r2Manifest].sort((a, b) => {
            // Sort Logic: Higher Revision first, then Newer Date
            if (b.revision !== a.revision) return b.revision - a.revision;
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        });

        // 7. Retention Policy (Delete oldest if we have too many)
        const MAX_CACHES_TO_KEEP = 2;

        if (updatedManifest.length > MAX_CACHES_TO_KEEP) {
            const cachesToDelete = updatedManifest.splice(MAX_CACHES_TO_KEEP); // Removes items from index 2 onwards

            for (const cacheToDelete of cachesToDelete) {
                console.log(`Retention policy: Deleting old cache ${cacheToDelete.name}...`);
                await deleteR2Directory(`caches/${cacheToDelete.name}`);
            }
        }

        // 8. Upload new caches.json
        console.log("Uploading updated caches.json...");
        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: "caches.json",
            Body: JSON.stringify(updatedManifest),
            ContentType: "application/json",
            CacheControl: "no-cache",
        }));

        console.log("Done.");

    } catch (err) {
        console.error("An error occurred:", err);
        process.exit(1);
    } finally {
        // Cleanup temp
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
}

// --- Helper Functions ---

async function fetchR2Manifest(): Promise<R2CacheManifestItem[]> {
    try {
        const res = await fetch(`${R2_PUBLIC_URL}/caches.json`);
        if (!res.ok) {
            if (res.status === 404) return [];
            throw new Error(`Failed to fetch manifest: ${res.statusText}`);
        }
        // Explicitly cast the JSON response to our interface
        return await res.json() as R2CacheManifestItem[];
    } catch (error) {
        console.warn("Could not fetch existing caches.json (first run?):", error);
        return [];
    }
}

async function fetchOpenRS2Caches(): Promise<OpenRS2Cache[]> {
    const resp = await fetch(`${OPENRS2_DOMAIN}/caches.json`);
    const json = (await resp.json()) as OpenRS2Cache[];

    const caches = json.filter(
        (cache) =>
            cache.scope === "runescape" &&
            cache.game === "oldschool" &&
            cache.language === "en" &&
            cache.builds.length > 0 &&
            cache.timestamp
    );

    return caches.sort((a, b) => {
        const buildA = a.builds[0].major;
        const buildB = b.builds[0].major;
        const dateA = Date.parse(a.timestamp);
        const dateB = Date.parse(b.timestamp);
        // Sort Newest to Oldest
        return (buildB - buildA) || (dateB - dateA);
    });
}

function getCacheDirName(cache: OpenRS2Cache): string {
    const build = cache.builds[0].major;
    const date = cache.timestamp.split("T")[0];
    if (cache.game === "oldschool") {
        if (cache.environment === "beta") {
            return `osrs-beta-${build}_${date}`;
        }
        return `osrs-${build}_${date}`;
    }
    const langPostfix = cache.language !== "en" ? "-" + cache.language : "";
    return `rs2-${build}${langPostfix}_${date}`;
}

async function downloadAndExtractCache(cache: OpenRS2Cache, destDir: string) {
    const url = `${OPENRS2_DOMAIN}/caches/${cache.scope}/${cache.id}/disk.zip`;
    console.log(`Fetching disk.zip from ${url}`);

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download cache: ${resp.statusText}`);

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const zip = new AdmZip(buffer);
    zip.extractAllTo(destDir, true);
}

async function saveXteas(cache: OpenRS2Cache, destDir: string) {
    const url = `${OPENRS2_DOMAIN}/caches/${cache.scope}/${cache.id}/keys.json`;
    const resp = await fetch(url);
    // Explicitly define the shape of the XTEA keys array
    const keys = await resp.json() as { group: number; key: string }[];

    const xteas: Record<string, string> = {};
    for (const entry of keys) {
        xteas[entry.group.toString()] = entry.key;
    }

    fs.writeFileSync(path.join(destDir, "keys.json"), JSON.stringify(xteas));
}

async function uploadDirectory(localDir: string, r2Prefix: string) {
    const files = fs.readdirSync(localDir);

    for (const file of files) {
        const filePath = path.join(localDir, file);
        const fileStat = fs.statSync(filePath);

        if (fileStat.isDirectory()) {
            await uploadDirectory(filePath, `${r2Prefix}/${file}`);
            continue;
        }

        const fileContent = fs.readFileSync(filePath);
        const contentType = file.endsWith(".json") ? "application/json" : "application/octet-stream";

        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: `${r2Prefix}/${file}`,
            Body: fileContent,
            ContentType: contentType,
        }));

        console.log(`Uploaded ${file}`);
    }
}

async function deleteR2Directory(prefix: string) {
    const dirPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    let continuationToken: string | undefined = undefined;

    do {
        const listCommand = new ListObjectsV2Command({
            Bucket: R2_BUCKET,
            Prefix: dirPrefix,
            ContinuationToken: continuationToken,
        });

        const listRes = await s3.send(listCommand);

        if (listRes.Contents && listRes.Contents.length > 0) {
            const objectsToDelete = listRes.Contents.map((obj) => ({ Key: obj.Key }));

            await s3.send(new DeleteObjectsCommand({
                Bucket: R2_BUCKET,
                Delete: { Objects: objectsToDelete },
            }));

            console.log(`Deleted ${objectsToDelete.length} files from ${dirPrefix}`);
        }

        continuationToken = listRes.NextContinuationToken;
    } while (continuationToken);
}

main();