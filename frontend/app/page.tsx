import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { Product } from "@/components/landing/Product";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Developers } from "@/components/landing/Developers";
import { FinalCta } from "@/components/landing/FinalCta";
import { Footer } from "@/components/landing/Footer";
import { GithubButton } from "@/components/landing/GithubButton";
import { Roles } from "@/components/landing/Roles";
import { Proof } from "@/components/landing/Proof";
import { Faq } from "@/components/landing/Faq";
import { Capabilities } from "@/components/landing/Capabilities";
import { GuideLoader } from "@/components/landing/GuideLoader";
import { WorldBackdrop } from "@/components/landing/WorldBackdrop";
import { NetworkMarquee } from "@/components/landing/NetworkMarquee";
import { OnePromptHook } from "@/components/landing/OnePromptHook";

export default function Home() {
  return (
    <main className="relative min-h-screen bg-[#0A0B1E] text-[#F5F5F7]">
      <WorldBackdrop />
      <Navbar />
      <Hero />
      <NetworkMarquee />
      <OnePromptHook />
      {/* everything below the hero is drawn at 85%, as if the browser were zoomed out a little: sections
          fit a laptop screen instead of needing a scroll each. (See .landing-zoom in globals.css.) */}
      <div className="landing-zoom">
      <Product />
      <Capabilities />
      <Roles />
      <HowItWorks />
      <Proof />
      <Developers />
      <Faq />
      <FinalCta />
      <Footer />
      </div>
      <GithubButton />
      <GuideLoader />
    </main>
  );
}
