import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="mt-2 text-muted-foreground">That address does not exist.</p>
      <Button className="mt-6" asChild>
        <Link to="/">Go to home</Link>
      </Button>
    </div>
  );
}
