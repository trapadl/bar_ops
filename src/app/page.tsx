import { redirect } from "next/navigation";
import { getAppSlug } from "@/lib/config";

export default function Home(): never {
  redirect(`/${getAppSlug()}/dashboard`);
}
