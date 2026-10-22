{
  "name": "asguard",
  "version": "0.1.0",
  "private": true,
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "build": "next build",
    "dev": "concurrently \"next dev\" \"node --env-file=.env --import tsx --watch server/index.ts\"",
    "dev:frontend": "next dev",
    "dev:backend": "node --env-file=.env --import tsx --watch server/index.ts",
    "lint": "eslint",
    "start": "next start",
    "backend:start": "node dist/server/index.js",
    "demo:trader": "node --env-file=.env --import tsx scripts/demo-trader.ts",
    "build:capsule": "cd capsule && cargo build --release",
    "install:local": "./install.sh",
    "daemon:start": "./scripts/asguard.sh start",
    "daemon:status": "./scripts/asguard.sh status",
    "daemon:logs": "./scripts/asguard.sh logs",
    "daemon:policy": "./scripts/asguard.sh policy",
    "daemon:audit": "./scripts/asguard.sh audit",
    "daemon:uninstall": "./scripts/asguard.sh uninstall"
  },
  "bin": {
    "asguard": "./scripts/asguard.sh"
  },
  "dependencies": {
    "@emotion/is-prop-valid": "latest",
    "@types/topojson-client": "^3.1.5",
    "@unicitylabs/sphere-sdk": "0.17.7",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "d3-geo": "^3.1.1",
    "drizzle-orm": "^0.45.2",
    "express": "^4.18.2",
    "framer-motion": "^12.23.25",
    "jiti": "latest",
    "lucide-react": "0.555.0",
    "next": "16.0.6",
    "pg": "^8.23.0",
    "prop-types": "latest",
    "react": "19.2.0",
    "react-dom": "19.2.0",
    "tailwind-merge": "3.4.0",
    "tailwindcss-animate": "1.0.7",
    "topojson-client": "^3.1.0",
    "ws": "^8.14.2"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/d3-geo": "^3.1.0",
    "@types/express": "^4.17.21",
    "@types/node": "^20",
    "@types/pg": "^8.23.1",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@types/ws": "^8.5.8",
    "concurrently": "^8.2.2",
    "eslint": "^9",
    "eslint-config-next": "16.0.6",
    "postcss": "8.5.6",
    "tailwindcss": "^4",
    "tsx": "^4.7.0",
    "typescript": "^5"
  }
}


"}]} server/approvalAttestation.ts, server/notifier.ts. Need new files separate call. Let's create new files now. Also patch index.ts and maybe more. We'll do later. We need ensure valid JSON to push_files. above JSON includes patch strings but maybe too large but okay. Let's do new file creation separate. Need add valid JSON content. Let's proceed with new files. Also note we must not forget `approvalAttestation.ts`/`notifier.ts` because patch earlier was not written for those. We can create new files after. Let's do as one call. Default branch main is okay. This is not create branch. Good. Let's do new files. Need include proper `owner` etc? push_files requires owner+repo. We used only branch maybe accepted? The earlier `push_files` in instructions says branch and repo/owner required. I forgot. Need include owner+repo. Let's do correct. We also need maybe not use main if branch exists? It's okay from repo default branch. Use branch 