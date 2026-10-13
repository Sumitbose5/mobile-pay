import { Link, Outlet } from 'react-router-dom';
import { BrandStyles } from '@/components/common/BrandStyles';
import { Button } from '@/components/ui/button';

const LOGO_URL =
  'https://res.cloudinary.com/dgxc8nspo/image/upload/v1791788542/Mobile_Pay__Dark_Glow_Logo-removebg-preview_ga7eja.png';

/**
 * Layout for logged-out pages. The header is deep pine (#0B2B2E) so the
 * white MobilePay logo stays readable.
 */
export function PublicLayout() {
  return (
    <div className="mp-home flex min-h-screen flex-col bg-[#FAFCFB]">
      <BrandStyles />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-[#F4A62A] focus:px-5 focus:py-2 focus:font-semibold focus:text-[#0B2B2E]"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 bg-[#0B2B2E]">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link
            to="/"
            className="flex items-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#F4A62A]"
          >
            <img src={LOGO_URL} alt="MobilePay" className="h-12 w-auto rounded-sm" />
          </Link>
          <nav className="flex items-center gap-2" aria-label="Account">
            <Button
              variant="ghost"
              asChild
              className="h-10 rounded-full px-5 font-semibold text-[#FAFCFB] hover:bg-white/10 hover:text-white"
            >
              <Link to="/login">Log in</Link>
            </Button>
            <Button
              asChild
              className="h-10 rounded-full bg-[#F4A62A] px-5 font-bold text-[#0B2B2E] shadow-none hover:bg-[#F7B64C]"
            >
              <Link to="/register">Create account</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        <Outlet />
      </main>

      <footer className="bg-[#0B2B2E] text-[#FAFCFB]/70">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center sm:px-6">
          <p>© {new Date().getFullYear()} MobilePay</p>
          <nav className="flex gap-6" aria-label="Footer">
            <Link to="/login" className="font-medium hover:text-white">
              Log in
            </Link>
            <Link to="/register" className="font-medium hover:text-white">
              Create account
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}