
// CompInput and NormalizedComp types for HobbyIQ
// import { ProvenanceScore } from './identity.types';

export interface CompInput {
	id?: string;
	source?: string;
	sourceUrl?: string;
	title?: string;
	price: number;
	currency?: string;
	date: string;
	listingType?: 'auction' | 'bin';
	listingStartDate?: string;
	saleDate?: string;
	bidderCount?: number;
	acceptedOffer?: boolean;
	acceptedOfferEstimatedDiscountPct?: number;
	sellerFeedbackScore?: number;
	sellerFeedbackCount?: number;
	imageCount?: number;
	titleQualityScore?: number;
	categoryAccuracyScore?: number;
	descriptionQualityScore?: number;
	parallel?: string;
	serialNumber?: string;
	gradeCompany?: string;
	gradeValue?: number | string;
	isAuto?: boolean;
	isPatch?: boolean;
	isNumbered?: boolean;
	cardYear?: number;
	product?: string;
	playerName?: string;
	team?: string;
	relistCount?: number;
	hadPriceCut?: boolean;
}

export interface NormalizedComp extends CompInput {
	normalized: boolean;
	recencyScore?: number;
	similarityScore?: number;
	provenanceScore?: { finalTrustScore?: number };
	compStrengthScore?: number;
	auctionQualityScore?: number;
	timeToSellScore?: number;
	listingQualityScore?: number;
}


