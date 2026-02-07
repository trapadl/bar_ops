import Link from "next/link";
import { notFound } from "next/navigation";
import { getAppSlug } from "@/lib/config";

interface SlugLayoutProps {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}

export default async function SlugLayout({
  children,
  params,
}: SlugLayoutProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  const appSlug = getAppSlug();

  if (slug !== appSlug) {
    notFound();
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">BarOps Live</p>
          <h1 className="headline">Night Operations</h1>
        </div>
        <nav className="tabnav" aria-label="Primary">
          <Link href={`/${appSlug}/dashboard`} className="tabnav-link">
            Dashboard
          </Link>
          <Link href={`/${appSlug}/config`} className="tabnav-link">
            Configuration
          </Link>
        </nav>
      </header>
      {children}
    </main>
  );
}
