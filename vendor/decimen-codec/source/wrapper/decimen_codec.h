#pragma once

#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

enum DecimenTrackedStatus : int32_t {
	DECIMEN_TRACK_INVALID = -1,
	DECIMEN_TRACK_MISS = 0,
	DECIMEN_TRACK_OK = 1,
	DECIMEN_TRACK_OUTPUT_FULL = 2,
};

struct DecimenTrackedResult {
	int32_t id;
	int32_t status;
	int32_t bytesOffset;
	int32_t bytesLength;
	int32_t consecutiveMisses;
	int32_t framesSinceReacquire;
	float dx;
	float dy;
};

struct DecimenGuidedTrack {
	int32_t id;
	int32_t dimension;
	float x0, y0, x1, y1, x2, y2, x3, y3;
};

struct DecimenGuidedResult {
	int32_t id;
	int32_t status;
	int32_t bytesOffset;
	int32_t bytesLength;
	int32_t dimension;
	float x0, y0, x1, y1, x2, y2, x3, y3;
};

struct DecimenGuidedMetrics {
	double totalMs;
	double binarizeMs;
	double finderMs;
	double sampleMs;
	double decodeMs;
	uint32_t tracks;
	uint32_t finderAttempts;
	uint32_t finderSuccesses;
	uint32_t finderTriplets;
	uint32_t sampleAttempts;
	uint32_t successful;
	uint32_t misses;
	uint32_t fastDecodeAttempts;
	uint32_t fastDecodeSuccesses;
	uint32_t genericDecodeAttempts;
	double fastDecodeMs;
	double genericDecodeMs;
};

struct DecimenBatchMetrics {
	double anchorMs;
	double samplingMs;
	double bitExtractionMs;
	double crcMs;
	double rsFallbackMs;
	double totalMs;
	uint32_t tracks;
	uint32_t samples;
	uint32_t successful;
	uint32_t misses;
	uint32_t crcFastSuccesses;
	uint32_t rsFallbacks;
	uint32_t anchorSuccesses;
	uint32_t anchorMisses;
	uint32_t alignmentFitAttempts;
	uint32_t outOfFrameMisses;
	uint32_t bitstreamFailures;
	uint32_t crcFailures;
	uint32_t alignmentFitSuccesses;
	uint32_t anchorBypassAttempts;
	uint32_t anchorBypassSuccesses;
	uint32_t translationAttempts;
	uint32_t translationSuccesses;
	uint32_t calibrationAttempts;
	uint32_t calibrationSuccesses;
};

int createTrackedDecoder(int maxTracks, int maxDimension);
void destroyTrackedDecoder(int handle);
int setTrackedDecoderTrack(int handle, int slot, int id, int dimension,
						   float x0, float y0, float x1, float y1,
						   float x2, float y2, float x3, float y3);
void clearTrackedDecoderTrack(int handle, int slot);
int setTrackedDecoderSampleMap(int handle, int slot, const float* xy, int pointCount);
void setTrackedDecoderTrackCRC32(int handle, int slot, int enabled);
void setTrackedDecoderFallbackBudget(int handle, int maxRSFallbacksPerFrame);
int decodeGuidedBatchY(const uint8_t* yPlane, int width, int height, int stride,
						 const DecimenGuidedTrack* tracks, int trackCount,
						 DecimenGuidedResult* results, int resultCapacity,
						 uint8_t* output, int outputCapacity, int maxSymbols,
						 DecimenGuidedMetrics* metrics);

int decodeTrackedBatchY(int handle, const uint8_t* yPlane, int width, int height, int stride,
						DecimenTrackedResult* results, int resultCapacity,
						uint8_t* output, int outputCapacity, DecimenBatchMetrics* metrics);
int decodeTrackedBatchRGBA(int handle, const uint8_t* rgba, int width, int height, int stride,
						   DecimenTrackedResult* results, int resultCapacity,
						   uint8_t* output, int outputCapacity, DecimenBatchMetrics* metrics);

#ifdef __cplusplus
}
#endif
