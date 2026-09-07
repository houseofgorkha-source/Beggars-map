import React from 'react';
import type { FilterParams } from '../hooks/useFilterParams';
import { denormalizeDimensionValue } from '../lib/extractDimensions';
import '../styles/breadcrumbs.css';

interface BreadcrumbsProps {
  filters: FilterParams;
}

export default function Breadcrumbs({ filters }: BreadcrumbsProps) {
  const parts: Array<{ label: string; isActive: boolean }> = [{ label: 'Home', isActive: true }];

  if (filters.cuisine) {
    parts.push({ label: denormalizeDimensionValue(filters.cuisine), isActive: true });
  }
  if (filters.mealType) {
    parts.push({ label: denormalizeDimensionValue(filters.mealType), isActive: true });
  }
  if (filters.dish) {
    parts.push({ label: denormalizeDimensionValue(filters.dish), isActive: true });
  }
  if (filters.location) {
    parts.push({ label: denormalizeDimensionValue(filters.location), isActive: true });
  }
  if (filters.price) {
    parts.push({ label: denormalizeDimensionValue(filters.price), isActive: true });
  }

  // Only show breadcrumbs if there are filters
  if (parts.length === 1) return null;

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {parts.map((part, i) => (
          <li key={i}>
            {part.isActive && i === parts.length - 1 ? (
              <span className="breadcrumb-current">{part.label}</span>
            ) : (
              <a href="/" className="breadcrumb-link">
                {part.label}
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
