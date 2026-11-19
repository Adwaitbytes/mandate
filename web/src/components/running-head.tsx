"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "./seal";

const links = [
  { href: "/", label: "The mandate" },
  { href: "/docket", label: "Docket" },
  { href: "/weights", label: "Weights" },
  { href: "/radar", label: "Radar" },
  { href: "/propose", label: "File a proposal" },
] as const;

export function RunningHead() {
  const path = usePathname();
  const current = (href: string) =>
    href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  return (
    <header className="running">
      <Link className="wordmark sc" href="/" aria-label="Mandate, home">
        <Wordmark />
        Mandate
      </Link>
      <nav aria-label="Primary">
        <ul>
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} aria-current={current(l.href) ? "page" : undefined}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <span className="where">Heard on Base Sepolia, tallied on Reactive Lasna</span>
    </header>
  );
}
