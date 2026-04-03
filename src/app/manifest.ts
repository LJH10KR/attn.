import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "attn.",
    short_name: "attn.",
    description: "학부모를 위한 출석·결석 알림 서비스",
    start_url: "/",
    display: "standalone",
    background_color: "#f2f1eb",
    theme_color: "#f2f1eb",
    icons: [
      {
        src: "/icon.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
