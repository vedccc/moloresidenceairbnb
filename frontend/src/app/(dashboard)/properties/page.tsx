'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchProperties } from '@/lib/properties-api';
import { PropertiesList } from './properties-client';
import { NewPropertyDrawer } from './new-property-drawer';

export default function PropertiesPage() {
  const { data: properties = [], isLoading } = useQuery({
    queryKey: ['properties'],
    queryFn: fetchProperties,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Properties</h1>
        <NewPropertyDrawer />
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading properties…</p>
      ) : (
        <PropertiesList properties={properties} />
      )}
    </div>
  );
}
