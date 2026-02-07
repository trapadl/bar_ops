import { MetadataRoute } from "next";
import { getAppSlug } from "@/lib/config";

export default function manifest(): MetadataRoute.Manifest {
  const slug = getAppSlug();

  return {
    name: "BarOps Live Dashboard",
    short_name: "BarOps",
    description: "Live bar manager dashboard for revenue and wage control.",
    start_url: `/${slug}/dashboard`,
    display: "standalone",
    background_color: "#050a12",
    theme_color: "#0e1827",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
