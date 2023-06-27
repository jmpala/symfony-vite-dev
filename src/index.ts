import { resolve, join, relative, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import util from "node:util";
import { fileURLToPath } from "node:url";

import { Plugin, UserConfig, ResolvedConfig } from "vite";
import sirv from "sirv";

import colors from "picocolors";

import type { RenderedChunk, OutputAsset, NormalizedOutputOptions, OutputChunk } from "rollup";

import { getDevEntryPoints, getBuildEntryPoints } from "./entryPointsHelper";
import {
  normalizePath,
  writeJson,
  emptyDir,
  isImportRequest,
  isInternalRequest,
  resolveDevServerUrl,
  isAddressInfo,
  isCssEntryPoint,
  getFileInfos,
  getInputRelPath,
} from "./utils";
import { resolvePluginOptions, resolveBase, resolveOutDir, refreshPaths } from "./pluginOptions";

import { VitePluginSymfonyOptions, StringMapping, GeneratedFiles } from "./types";

// src and dist directory are in the same level;
const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));

export default function symfony(userOptions: Partial<VitePluginSymfonyOptions> = {}): Plugin {
  const pluginOptions = resolvePluginOptions(userOptions);
  let viteConfig: ResolvedConfig;
  let viteDevServerUrl: string;

  const entryPointsBasename = "entrypoints.json";

  const inputRelPath2outputRelPath: StringMapping = {};
  const generatedFiles: GeneratedFiles = {};

  let outputCount = 0;

  return {
    name: "symfony",
    enforce: "post",
    config(userConfig) {
      if (userConfig.build.rollupOptions.input instanceof Array) {
        console.error("rollupOptions.input must be an Objet like {app: './assets/app.js'}");
        process.exit(1);
      }

      const extraConfig: UserConfig = {
        base: userConfig.base ?? resolveBase(pluginOptions),
        publicDir: false,
        build: {
          manifest: true,
          outDir: userConfig.build?.outDir ?? resolveOutDir(pluginOptions),
        },
        optimizeDeps: {
          //Set to true to force dependency pre-bundling.
          force: true,
        },
      };

      return extraConfig;
    },
    configResolved(config) {
      viteConfig = config;
    },
    configureServer(devServer) {
      // vite server is running

      const { watcher, ws } = devServer;

      // empty the buildDir and create an entrypoints.json file inside.
      devServer.httpServer?.once("listening", () => {
        if (viteConfig.env.DEV) {
          const buildDir = resolve(viteConfig.root, viteConfig.build.outDir);

          if (!existsSync(buildDir)) {
            mkdirSync(buildDir, { recursive: true });
          }

          existsSync(buildDir) && emptyDir(buildDir);

          const address = devServer.httpServer?.address();

          if (!isAddressInfo(address)) {
            console.error("address is not an object open an issue with your address value to fix the problem", address);
            process.exit(1);
          }

          viteDevServerUrl = resolveDevServerUrl(address, devServer.config, pluginOptions);

          const entryPoints = getDevEntryPoints(viteConfig, viteDevServerUrl);

          const entryPointsPath = resolve(viteConfig.root, viteConfig.build.outDir, entryPointsBasename);
          writeJson(entryPointsPath, {
            isProd: false,
            viteServer: {
              origin: viteDevServerUrl,
              base: viteConfig.base,
            },
            entryPoints,
            legacy: false,
          });
        }

        if (pluginOptions.debug) {
          setTimeout(() => {
            devServer.config.logger.info(`\n${colors.green("➜")}  Vite Config \n`);
            devServer.config.logger.info(util.inspect(viteConfig, { showHidden: false, depth: null, colors: true }));
            devServer.config.logger.info(`\n${colors.green("➜")}  End of config \n`);
          }, 100);
        }
      });

      // full reload vite dev server if twig files are modified.
      if (pluginOptions.refresh !== false) {
        const paths = pluginOptions.refresh === true ? refreshPaths : pluginOptions.refresh;
        for (const path of paths) {
          watcher.add(path);
        }
        watcher.on("change", function (path) {
          if (path.endsWith(".twig")) {
            ws.send({
              type: "full-reload",
            });
          }
        });
      }

      if (pluginOptions.servePublic) {
        // inspired by https://github.com/vitejs/vite
        // file: packages/vite/src/node/server/middlewares/static.ts
        const serve = sirv(pluginOptions.publicDirectory, {
          dev: true,
          etag: true,
          extensions: [],
          setHeaders(res, pathname) {
            // Matches js, jsx, ts, tsx.
            // The reason this is done, is that the .ts file extension is reserved
            // for the MIME type video/mp2t. In almost all cases, we can expect
            // these files to be TypeScript files, and for Vite to serve them with
            // this Content-Type.
            if (/\.[tj]sx?$/.test(pathname)) {
              res.setHeader("Content-Type", "application/javascript");
            }

            res.setHeader("Access-Control-Allow-Origin", "*");
          },
        });
        devServer.middlewares.use(function viteServePublicMiddleware(req, res, next) {
          if (req.url === "/" || req.url === "/build/") {
            res.statusCode = 404;
            res.end(readFileSync(join(pluginDir, "static/dev-server-404.html")));
            return;
          }

          // skip import request and internal requests `/@fs/ /@vite-client` etc...
          if (isImportRequest(req.url!) || isInternalRequest(req.url!)) {
            return next();
          }
          serve(req, res, next);
        });
      }
    },
    async renderChunk(code: string, chunk: RenderedChunk) {
      if (!isCssEntryPoint(chunk)) {
        return;
      }

      // Here we have only css entryPoints
      const cssAssetName = chunk.facadeModuleId
        ? normalizePath(relative(viteConfig.root, chunk.facadeModuleId))
        : chunk.name;

      // chunk.viteMetadata.importedCss contains a Set of relative file paths of css files
      // in our case we have only one file.
      // eg: inputRelPath2outputRelPath['assets/theme.scss'] = 'assets/theme-44b5be96.css';
      chunk.viteMetadata.importedCss.forEach((cssBuildFilename) => {
        inputRelPath2outputRelPath[cssAssetName] = cssBuildFilename;
      });
    },
    generateBundle(options: NormalizedOutputOptions, bundle: { [fileName: string]: OutputAsset | OutputChunk }) {
      for (const chunk of Object.values(bundle)) {
        const inputRelPath = getInputRelPath(chunk, options, viteConfig);
        inputRelPath2outputRelPath[inputRelPath] = chunk.fileName;
        generatedFiles[chunk.fileName] = getFileInfos(chunk, inputRelPath, pluginOptions);
      }

      outputCount++;
      const output = viteConfig.build.rollupOptions?.output;

      // if we have multiple build passes output is an array of each passe.
      // else we have an object of this unique pass
      const outputLength = Array.isArray(output) ? output.length : 1;

      if (outputCount >= outputLength) {
        const entryPoints = getBuildEntryPoints(generatedFiles, viteConfig, inputRelPath2outputRelPath);

        this.emitFile({
          fileName: entryPointsBasename,
          source: JSON.stringify(
            {
              entryPoints,
              isProd: true,
              legacy: typeof entryPoints["polyfills-legacy"] !== "undefined",
              viteServer: false,
            },
            null,
            pluginOptions.debug ? 2 : null,
          ),
          type: "asset",
        });
      }
    },
  };
}
