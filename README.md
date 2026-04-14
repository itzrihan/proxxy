# Shinra Proxy — Edge Edition

A CORS proxy rebuilt on **Vercel Edge Runtime** to eliminate Origin Transfer usage.

## Why the old version maxed out Origin Transfer

The original proxy ran as a **Vercel Serverless Function** (Node.js). Every byte
proxied had to travel:

```
Client → Vercel Edge → Vercel Origin (your function) → Target Server
                   ↑
         counted as Origin Transfer
```

For media streams (HLS `.ts` segments, `.mp4` chunks etc.) this adds up fast.

## How this version fixes it

This version runs as a **Vercel Edge Function**. Edge Functions execute *at the
CDN layer*, not at the origin:

```
Client → Vercel Edge Node (your function runs HERE) → Target Server
         ↑
         NO origin transfer — edge nodes are the CDN
```

Additionally, this version sets aggressive `Cache-Control` headers:

| Content type | Cache-Control |
|---|---|
| `.ts`, `.m4s`, `.mp4`, `.mp3`, `.aac` (media segments) | `immutable, 1 year` at CDN |
| `.m3u8` (HLS playlist) | `3 seconds` at CDN |
| `.vtt`, `.srt` (subtitles) | `5 minutes` at CDN |
| Everything else | `60 seconds` at CDN |

Cached responses are served directly from the CDN edge — zero function invocations,
zero Origin Transfer, zero CPU time consumed.

## Usage

```
# Query parameter
https://your-deployment.vercel.app/proxy?url=https://example.com/video/segment.ts

# Path parameter
https://your-deployment.vercel.app/proxy/https://example.com/video/segment.ts

# Base64 encoded URL
https://your-deployment.vercel.app/proxy/base64/<base64-encoded-url>
```

## Deploy

```bash
npm install
npx vercel --prod
```

## Features

- ✅ Zero Origin Transfer (Edge Runtime)
- ✅ CDN caching for media segments (immutable, 1 year)
- ✅ M3U8 playlist URL rewriting
- ✅ WebVTT subtitle URL rewriting
- ✅ Full CORS headers
- ✅ Range request passthrough (for video seeking)
- ✅ SSRF protection (blocks localhost/private IPs)
- ✅ Zero dependencies (no Express, no node-fetch, no worker threads)
- ✅ Streams response body — no buffering in memory
