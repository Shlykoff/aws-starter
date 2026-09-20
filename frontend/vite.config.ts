import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // `@` -> `src`. Keep it in sync with tsconfig.json (`paths`) and components.json.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // The Cognito app client only accepts http://localhost:5173/auth/callback as a
    // redirect URL and http://localhost:5173/ as a sign-out URL. If the port were free to
    // change, sign-in would fail with "redirect_mismatch", so fail loudly instead.
    port: 5173,
    strictPort: true,
  },
});
